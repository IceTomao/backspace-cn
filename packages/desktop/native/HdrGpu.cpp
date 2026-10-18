// One D3D11 device: WGC FP16 texture -> HDR compute shader -> P010 -> NVENC.
// No raw pixel readback/upload, CPU color conversion, software video encoder,
// secondary video track or desktop capture during synthetic verification.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11_3.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <memory>
#include <mutex>
#include "WgcAbi.h"
#include "vendor/nvEncodeAPI.h"
#include "HdrGpuShader.h"

template<class T> class Ptr {
    T* pointer = nullptr;
public:
    Ptr() = default;
    ~Ptr() { reset(); }
    Ptr(const Ptr&) = delete; Ptr& operator=(const Ptr&) = delete;
    T* get() const { return pointer; }
    T* operator->() const { return pointer; }
    T** put() { reset(); return &pointer; }
    void reset() { if (pointer) pointer->Release(); pointer = nullptr; }
    void swap(Ptr& other) { std::swap(pointer, other.pointer); }
};
static void check(HRESULT code, const char* operation) {
    if (FAILED(code)) throw std::runtime_error(std::string(operation) + ":" + std::to_string(static_cast<unsigned long>(code)));
}
template<class T, class U> static void query(U* from, Ptr<T>& to) {
    check(from->QueryInterface(__uuidof(T), reinterpret_cast<void**>(to.put())), "query_interface");
}
template<class T> static void factory(const wchar_t* name, Ptr<T>& result) {
    HSTRING text = nullptr;
    check(WindowsCreateString(name, static_cast<UINT32>(wcslen(name)), &text), "runtime_class");
    HRESULT code = RoGetActivationFactory(text, __uuidof(T), reinterpret_cast<void**>(result.put()));
    WindowsDeleteString(text); check(code, "capture_factory");
}
static void closeCapture(IUnknown* value) {
    if (!value) return;
    Ptr<wgc::Closable> closable;
    if (SUCCEEDED(value->QueryInterface(__uuidof(wgc::Closable), reinterpret_cast<void**>(closable.put())))) closable->Close();
}
struct Options {
    UINT width = 1920, height = 1080, fps = 60, bitrate = 16000, frames = 0, pattern = 0;
    UINT syntheticWidth = 0, syntheticHeight = 0;
    int exposureTenths = 0, brightness = 0;
    HMONITOR monitor = nullptr;
    bool synthetic = false, watchParent = false, realtime = false;
};
static unsigned long long number(const char* value) {
    if (!*value || strspn(value, "0123456789") != strlen(value) || strlen(value) > 20) throw std::runtime_error("invalid_numeric_argument");
    try { return std::stoull(value); }
    catch (...) { throw std::runtime_error("invalid_numeric_argument"); }
}
static Options options(int argc, char** argv) {
    Options o;
    for (int i = 1; i < argc; i++) {
        std::string key(argv[i]);
        if (key == "--synthetic") { o.synthetic = true; continue; }
        if (key == "--watch-parent") { o.watchParent = true; continue; }
        if (key == "--realtime") { o.realtime = true; continue; }
        if (++i >= argc) throw std::runtime_error("missing_argument");
        if (key == "--exposure-tenths" || key == "--brightness") {
            const char* text = argv[i]; const char* digits = *text == '-' ? text + 1 : text;
            auto amount = number(digits);
            if (amount > (key == "--exposure-tenths" ? 30u : 50u)) throw std::runtime_error("invalid_hdr_color");
            int value = static_cast<int>(amount) * (*text == '-' ? -1 : 1);
            if (key == "--exposure-tenths") o.exposureTenths = value; else o.brightness = value;
            continue;
        }
        auto n = number(argv[i]);
        if (key == "--monitor") {
            if (!n) throw std::runtime_error("invalid_monitor");
            o.monitor = reinterpret_cast<HMONITOR>(static_cast<uintptr_t>(n)); continue;
        }
        if (n > 200000) throw std::runtime_error("argument_exceeds_limit");
        if (key == "--width") o.width = static_cast<UINT>(n);
        else if (key == "--height") o.height = static_cast<UINT>(n);
        else if (key == "--fps") o.fps = static_cast<UINT>(n);
        else if (key == "--bitrate-kbps") o.bitrate = static_cast<UINT>(n);
        else if (key == "--frames") o.frames = static_cast<UINT>(n);
        else if (key == "--pattern") o.pattern = static_cast<UINT>(n);
        else if (key == "--source-width") o.syntheticWidth = static_cast<UINT>(n);
        else if (key == "--source-height") o.syntheticHeight = static_cast<UINT>(n);
        else throw std::runtime_error("unknown_argument");
    }
    if (o.width < 256 || o.width > 7680 || o.width % 2 || o.height < 128 || o.height > 4320 || o.height % 2 ||
        o.fps < 1 || o.fps > 120 || o.bitrate < 500 || o.bitrate > 200000 || o.pattern > 2 ||
        o.synthetic == (o.monitor != nullptr) || (o.synthetic && (!o.frames || o.frames > 7200)) ||
        ((o.syntheticWidth || o.syntheticHeight) && (!o.synthetic || !o.syntheticWidth || !o.syntheticHeight ||
            o.syntheticWidth > 16384 || o.syntheticHeight > 16384))) throw std::runtime_error("invalid_hdr_configuration");
    return o;
}

struct ColorState {
    std::mutex mutex;
    uint32_t revision = 0;
    int exposureTenths = 0, brightness = 0;
};
struct ColorPacket { char magic[4]; uint32_t revision; int32_t exposureTenths, brightness; };
static_assert(sizeof(ColorPacket) == 16, "HDR stdin protocol size");

class Pipeline {
    Options o;
    std::shared_ptr<ColorState> color = std::make_shared<ColorState>();
    uint32_t appliedRevision = 0, reportedRevision = 0;
    int appliedExposure = 0, appliedBrightness = 0;
    Ptr<IDXGIAdapter1> adapter;
    Ptr<ID3D11Device> device;
    Ptr<ID3D11DeviceContext> context;
    Ptr<ID3D11Texture2D> input, output;
    Ptr<ID3D11ShaderResourceView> source;
    Ptr<ID3D11UnorderedAccessView> inputUav, luma, chroma;
    Ptr<ID3D11ComputeShader> converter, generator;
    Ptr<ID3D11SamplerState> sampler;
    Ptr<ID3D11Buffer> parameters;
    Ptr<wgc::Pool> pool;
    Ptr<wgc::Session> session;
    UINT sourceWidth = 0, sourceHeight = 0;
    HMODULE nvLibrary = nullptr;
    NV_ENCODE_API_FUNCTION_LIST nv = {};
    void* encoder = nullptr;
    NV_ENC_REGISTERED_PTR registered = nullptr;
    NV_ENC_OUTPUT_PTR bitstream = nullptr;
    UINT64 encodedBytes = 0;

    void nvCheck(NVENCSTATUS status, const char* operation) {
        if (status != NV_ENC_SUCCESS) throw std::runtime_error(std::string(operation) + ":" + std::to_string(status));
    }
    void selectAdapter() {
        Ptr<IDXGIFactory1> dxgi;
        check(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(dxgi.put())), "dxgi_factory");
        for (UINT a = 0; ; a++) {
            Ptr<IDXGIAdapter1> candidate;
            auto status = dxgi->EnumAdapters1(a, candidate.put());
            if (status == DXGI_ERROR_NOT_FOUND) break;
            check(status, "enumerate_adapters");
            DXGI_ADAPTER_DESC1 desc = {}; check(candidate->GetDesc1(&desc), "adapter_description");
            if (desc.VendorId != 0x10de || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
            bool selected = o.synthetic;
            for (UINT i = 0; !selected; i++) {
                Ptr<IDXGIOutput> screen;
                auto outputStatus = candidate->EnumOutputs(i, screen.put());
                if (outputStatus == DXGI_ERROR_NOT_FOUND) break;
                check(outputStatus, "enumerate_outputs");
                DXGI_OUTPUT_DESC d = {}; check(screen->GetDesc(&d), "output_description");
                selected = d.Monitor == o.monitor;
            }
            if (selected) { adapter.swap(candidate); return; }
        }
        throw std::runtime_error("selected_monitor_requires_supported_nvidia_adapter");
    }
    void requireHdrOutput() {
        bool found = false;
        for (UINT i = 0; ; i++) {
            Ptr<IDXGIOutput> screen;
            auto status = adapter->EnumOutputs(i, screen.put());
            if (status == DXGI_ERROR_NOT_FOUND) break;
            check(status, "enumerate_outputs");
            DXGI_OUTPUT_DESC d = {}; check(screen->GetDesc(&d), "output_description");
            if (d.Monitor != o.monitor) continue;
            Ptr<IDXGIOutput6> advanced; query(screen.get(), advanced);
            DXGI_OUTPUT_DESC1 current = {}; check(advanced->GetDesc1(&current), "hdr_output_description");
            if (!current.AttachedToDesktop || current.ColorSpace != DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020) throw std::runtime_error("output_hdr_disabled");
            if (sourceWidth && (current.DesktopCoordinates.right - current.DesktopCoordinates.left != static_cast<LONG>(sourceWidth) ||
                current.DesktopCoordinates.bottom - current.DesktopCoordinates.top != static_cast<LONG>(sourceHeight))) throw std::runtime_error("capture_monitor_changed");
            found = true; break;
        }
        if (!found) throw std::runtime_error("capture_monitor_removed");
    }
    void createCapture() {
        check(RoInitialize(RO_INIT_MULTITHREADED), "runtime_initialization");
        Ptr<wgc::ItemInterop> interop; factory(L"Windows.Graphics.Capture.GraphicsCaptureItem", interop);
        Ptr<wgc::Item> item;
        check(interop->ForMonitor(o.monitor, __uuidof(wgc::Item), reinterpret_cast<void**>(item.put())), "capture_monitor");
        wgc::Size size = {}; check(item->GetSize(&size), "capture_size");
        if (size.Width < 1 || size.Height < 1 || size.Width > 16384 || size.Height > 16384) throw std::runtime_error("invalid_capture_size");
        sourceWidth = static_cast<UINT>(size.Width); sourceHeight = static_cast<UINT>(size.Height);
        Ptr<IDXGIDevice> dxgiDevice; query(device.get(), dxgiDevice);
        Ptr<IInspectable> runtimeDevice;
        auto create = reinterpret_cast<HRESULT(WINAPI*)(IDXGIDevice*, IInspectable**)>(GetProcAddress(GetModuleHandleW(L"d3d11.dll"), "CreateDirect3D11DeviceFromDXGIDevice"));
        if (!create) throw std::runtime_error("capture_device_unavailable");
        check(create(dxgiDevice.get(), runtimeDevice.put()), "capture_device");
        Ptr<wgc::Device> graphicsDevice; query(runtimeDevice.get(), graphicsDevice);
        Ptr<wgc::PoolStatics> statics; factory(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", statics);
        check(statics->CreateFreeThreaded(graphicsDevice.get(), static_cast<INT32>(DXGI_FORMAT_R16G16B16A16_FLOAT), 2, size, pool.put()), "capture_frame_pool");
        check(pool->CreateSession(item.get(), session.put()), "capture_session");
        check(session->StartCapture(), "capture_start");
    }
    void shader(const char* entry, Ptr<ID3D11ComputeShader>& result) {
        Ptr<ID3DBlob> code, errors;
        HMODULE compiler = LoadLibraryExW(L"d3dcompiler_47.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!compiler) throw std::runtime_error("shader_compiler_unavailable");
        auto compile = reinterpret_cast<pD3DCompile>(GetProcAddress(compiler, "D3DCompile"));
        if (!compile) { FreeLibrary(compiler); throw std::runtime_error("shader_compiler_api_unavailable"); }
        auto status = compile(HdrGpuShader, strlen(HdrGpuShader), "HdrGpuShader.hlsl", nullptr, nullptr, entry, "cs_5_0",
            D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, code.put(), errors.put());
        if (FAILED(status) && errors.get()) fprintf(stderr, "%.*s\n", static_cast<int>(errors->GetBufferSize()), static_cast<char*>(errors->GetBufferPointer()));
        check(status, "shader_compile");
        check(device->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, result.put()), "compute_shader");
        // Blob vtables belong to the compiler DLL; release before unloading it.
        errors.reset(); code.reset(); FreeLibrary(compiler);
    }
    void createTextures() {
        D3D11_TEXTURE2D_DESC d = {};
        d.Width = sourceWidth; d.Height = sourceHeight; d.MipLevels = 1; d.ArraySize = 1;
        d.Format = DXGI_FORMAT_R16G16B16A16_FLOAT; d.SampleDesc.Count = 1;
        d.Usage = D3D11_USAGE_DEFAULT; d.BindFlags = D3D11_BIND_SHADER_RESOURCE | (o.synthetic ? D3D11_BIND_UNORDERED_ACCESS : 0);
        check(device->CreateTexture2D(&d, nullptr, input.put()), "fp16_texture");
        check(device->CreateShaderResourceView(input.get(), nullptr, source.put()), "fp16_shader_view");
        if (o.synthetic) check(device->CreateUnorderedAccessView(input.get(), nullptr, inputUav.put()), "synthetic_texture_view");
        d.Width = o.width; d.Height = o.height; d.Format = DXGI_FORMAT_P010;
        d.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE;
        check(device->CreateTexture2D(&d, nullptr, output.put()), "p010_texture");
        Ptr<ID3D11Device3> modern; query(device.get(), modern);
        D3D11_UNORDERED_ACCESS_VIEW_DESC1 view = {};
        view.ViewDimension = D3D11_UAV_DIMENSION_TEXTURE2D;
        view.Format = DXGI_FORMAT_R16_UINT;
        Ptr<ID3D11UnorderedAccessView1> plane;
        check(modern->CreateUnorderedAccessView1(output.get(), &view, plane.put()), "p010_luma_view"); query(plane.get(), luma);
        view.Format = DXGI_FORMAT_R16G16_UINT; view.Texture2D.PlaneSlice = 1;
        check(modern->CreateUnorderedAccessView1(output.get(), &view, plane.put()), "p010_chroma_view"); query(plane.get(), chroma);
        D3D11_BUFFER_DESC buffer = {}; buffer.ByteWidth = 32; buffer.Usage = D3D11_USAGE_DEFAULT; buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        check(device->CreateBuffer(&buffer, nullptr, parameters.put()), "shader_parameters");
        D3D11_SAMPLER_DESC sample = {}; sample.Filter = D3D11_FILTER_MIN_MAG_LINEAR_MIP_POINT;
        sample.AddressU = sample.AddressV = sample.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP; sample.MaxLOD = D3D11_FLOAT32_MAX;
        check(device->CreateSamplerState(&sample, sampler.put()), "shader_sampler");
        shader("Convert", converter); if (o.synthetic) shader("Generate", generator);
    }
    void createEncoder() {
        // The driver DLL comes from System32, never an application search path.
        nvLibrary = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!nvLibrary) throw std::runtime_error("nvenc_unavailable");
        auto create = reinterpret_cast<NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*)>(GetProcAddress(nvLibrary, "NvEncodeAPICreateInstance"));
        if (!create) throw std::runtime_error("nvenc_api_unavailable");
        nv.version = NV_ENCODE_API_FUNCTION_LIST_VER; nvCheck(create(&nv), "nvenc_api");
        NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {};
        open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER; open.device = device.get();
        open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX; open.apiVersion = NVENCAPI_VERSION;
        nvCheck(nv.nvEncOpenEncodeSessionEx(&open, &encoder), "nvenc_session");
        NV_ENC_PRESET_CONFIG preset = {}; preset.version = NV_ENC_PRESET_CONFIG_VER; preset.presetCfg.version = NV_ENC_CONFIG_VER;
        // Leave more encoding headroom for live WGC + transport at UHD sizes.
        const GUID presetGuid = o.width * o.height >= 3840u * 2160u ? NV_ENC_PRESET_P3_GUID : NV_ENC_PRESET_P4_GUID;
        nvCheck(nv.nvEncGetEncodePresetConfigEx(encoder, NV_ENC_CODEC_HEVC_GUID, presetGuid,
            NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset), "nvenc_preset");
        auto& config = preset.presetCfg;
        config.profileGUID = NV_ENC_HEVC_PROFILE_MAIN10_GUID; config.gopLength = o.fps * 2; config.frameIntervalP = 1;
        config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
        config.rcParams.averageBitRate = config.rcParams.maxBitRate = o.bitrate * 1000;
        config.rcParams.vbvBufferSize = o.bitrate * 250; config.rcParams.vbvInitialDelay = o.bitrate * 250;
        config.rcParams.enableLookahead = 0; config.rcParams.lookaheadDepth = 0;
        auto& hevc = config.encodeCodecConfig.hevcConfig;
        hevc.chromaFormatIDC = 1; hevc.inputBitDepth = hevc.outputBitDepth = NV_ENC_BIT_DEPTH_10;
        hevc.idrPeriod = o.fps * 2; hevc.outputAUD = 1; hevc.repeatSPSPPS = 1;
        hevc.hevcVUIParameters.videoSignalTypePresentFlag = 1;
        hevc.hevcVUIParameters.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
        hevc.hevcVUIParameters.videoFullRangeFlag = 0; hevc.hevcVUIParameters.colourDescriptionPresentFlag = 1;
        hevc.hevcVUIParameters.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT2020;
        hevc.hevcVUIParameters.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SMPTE2084;
        hevc.hevcVUIParameters.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT2020_NCL;
        // The shader averages each 2x2 block; signal centered chroma rather
        // than the default left sample position used by many HEVC decoders.
        hevc.hevcVUIParameters.chromaSampleLocationFlag = 1;
        hevc.hevcVUIParameters.chromaSampleLocationTop = hevc.hevcVUIParameters.chromaSampleLocationBot = 1;
        NV_ENC_INITIALIZE_PARAMS init = {}; init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.presetGUID = presetGuid;
        init.encodeWidth = init.darWidth = init.maxEncodeWidth = o.width;
        init.encodeHeight = init.darHeight = init.maxEncodeHeight = o.height;
        init.frameRateNum = o.fps; init.frameRateDen = 1; init.enablePTD = 1;
        init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY; init.encodeConfig = &config;
        nvCheck(nv.nvEncInitializeEncoder(encoder, &init), "nvenc_initialize");
        NV_ENC_REGISTER_RESOURCE resource = {}; resource.version = NV_ENC_REGISTER_RESOURCE_VER;
        resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; resource.resourceToRegister = output.get();
        resource.width = o.width; resource.height = o.height; resource.bufferFormat = NV_ENC_BUFFER_FORMAT_YUV420_10BIT;
        resource.bufferUsage = NV_ENC_INPUT_IMAGE;
        nvCheck(nv.nvEncRegisterResource(encoder, &resource), "nvenc_register_p010"); registered = resource.registeredResource;
        NV_ENC_CREATE_BITSTREAM_BUFFER bits = {}; bits.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
        nvCheck(nv.nvEncCreateBitstreamBuffer(encoder, &bits), "nvenc_bitstream_buffer"); bitstream = bits.bitstreamBuffer;
    }
    bool captureFrame() {
        Ptr<wgc::Frame> newest;
        for (;;) {
            Ptr<wgc::Frame> next; check(pool->NextFrame(next.put()), "capture_next_frame");
            if (!next.get()) break;
            closeCapture(newest.get()); newest.swap(next);
        }
        if (!newest.get()) return false;
        try {
            wgc::Size size = {}; check(newest->ContentSize(&size), "capture_content_size");
            if (size.Width != static_cast<INT32>(sourceWidth) || size.Height != static_cast<INT32>(sourceHeight)) throw std::runtime_error("capture_monitor_changed");
            Ptr<IInspectable> surface; check(newest->Surface(surface.put()), "capture_surface");
            Ptr<wgc::DxgiAccess> access; query(surface.get(), access);
            Ptr<ID3D11Texture2D> texture;
            check(access->GetInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.put())), "capture_texture");
            D3D11_TEXTURE2D_DESC description = {}; texture->GetDesc(&description);
            if (description.Format != DXGI_FORMAT_R16G16B16A16_FLOAT || description.Width != sourceWidth || description.Height != sourceHeight) throw std::runtime_error("capture_not_fp16");
            context->CopyResource(input.get(), texture.get()); context->Flush();
        } catch (...) { closeCapture(newest.get()); throw; }
        closeCapture(newest.get()); return true;
    }
    void convert(UINT frame) {
        {
            std::lock_guard<std::mutex> guard(color->mutex);
            appliedRevision = color->revision; appliedExposure = color->exposureTenths; appliedBrightness = color->brightness;
        }
        struct Parameters { UINT width, height, sourceWidth, sourceHeight, frame, pattern; float exposureGain, brightness; };
        static_assert(sizeof(Parameters) == 32, "HLSL constant buffer layout");
        Parameters params = {o.width, o.height, sourceWidth, sourceHeight, frame, o.pattern,
            std::exp2(appliedExposure / 10.0f), appliedBrightness / 100.0f};
        context->UpdateSubresource(parameters.get(), 0, nullptr, &params, 0, 0);
        auto cb = parameters.get(); context->CSSetConstantBuffers(0, 1, &cb);
        ID3D11UnorderedAccessView* empty[2] = {nullptr, nullptr};
        if (o.synthetic) {
            auto target = inputUav.get(); context->CSSetUnorderedAccessViews(0, 1, &target, nullptr);
            context->CSSetShader(generator.get(), nullptr, 0); context->Dispatch((sourceWidth + 7) / 8, (sourceHeight + 7) / 8, 1);
            context->CSSetUnorderedAccessViews(0, 2, empty, nullptr);
        }
        auto image = source.get(); auto filter = sampler.get(); ID3D11UnorderedAccessView* planes[2] = {luma.get(), chroma.get()};
        context->CSSetShader(converter.get(), nullptr, 0); context->CSSetShaderResources(0, 1, &image);
        context->CSSetSamplers(0, 1, &filter); context->CSSetUnorderedAccessViews(0, 2, planes, nullptr);
        context->Dispatch((o.width + 15) / 16, (o.height + 15) / 16, 1);
        context->CSSetUnorderedAccessViews(0, 2, empty, nullptr);
        image = nullptr; context->CSSetShaderResources(0, 1, &image); context->Flush();
    }
    void encode(UINT frame) {
        NV_ENC_MAP_INPUT_RESOURCE map = {}; map.version = NV_ENC_MAP_INPUT_RESOURCE_VER; map.registeredResource = registered;
        nvCheck(nv.nvEncMapInputResource(encoder, &map), "nvenc_map_texture");
        try {
            NV_ENC_PIC_PARAMS picture = {}; picture.version = NV_ENC_PIC_PARAMS_VER;
            picture.inputBuffer = map.mappedResource; picture.bufferFmt = NV_ENC_BUFFER_FORMAT_YUV420_10BIT;
            picture.inputWidth = o.width; picture.inputHeight = o.height; picture.outputBitstream = bitstream;
            picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME; picture.frameIdx = frame;
            picture.inputTimeStamp = static_cast<UINT64>(frame) * 10000000 / o.fps; picture.inputDuration = 10000000 / o.fps;
            nvCheck(nv.nvEncEncodePicture(encoder, &picture), "nvenc_encode");
            NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = NV_ENC_LOCK_BITSTREAM_VER; lock.outputBitstream = bitstream;
            nvCheck(nv.nvEncLockBitstream(encoder, &lock), "nvenc_lock_bitstream");
            auto written = fwrite(lock.bitstreamBufferPtr, 1, lock.bitstreamSizeInBytes, stdout);
            encodedBytes += written;
            nvCheck(nv.nvEncUnlockBitstream(encoder, bitstream), "nvenc_unlock_bitstream");
            if (written != lock.bitstreamSizeInBytes || fflush(stdout)) throw std::runtime_error("publisher_pipe_closed");
        } catch (...) { nv.nvEncUnmapInputResource(encoder, map.mappedResource); throw; }
        nvCheck(nv.nvEncUnmapInputResource(encoder, map.mappedResource), "nvenc_unmap_texture");
    }
public:
    explicit Pipeline(Options options) : o(options) { color->exposureTenths = o.exposureTenths; color->brightness = o.brightness; }
    ~Pipeline() {
        closeCapture(session.get()); closeCapture(pool.get());
        if (encoder) {
            if (registered) nv.nvEncUnregisterResource(encoder, registered);
            if (bitstream) nv.nvEncDestroyBitstreamBuffer(encoder, bitstream);
            nv.nvEncDestroyEncoder(encoder);
        }
        if (nvLibrary) FreeLibrary(nvLibrary);
    }
    void run() {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        selectAdapter(); if (!o.synthetic) requireHdrOutput();
        D3D_FEATURE_LEVEL level;
        check(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
            D3D11_SDK_VERSION, device.put(), &level, context.put()), "d3d11_device");
        if (level < D3D_FEATURE_LEVEL_11_0) throw std::runtime_error("d3d11_compute_unavailable");
        if (o.synthetic) { sourceWidth = o.syntheticWidth ? o.syntheticWidth : o.width; sourceHeight = o.syntheticHeight ? o.syntheticHeight : o.height; }
        else createCapture();
        createTextures(); createEncoder();
        if (o.watchParent) {
            // A private, fixed-size control pipe also binds process lifetime.
            // No executable paths, JSON, credentials or image pixels enter it.
            _setmode(_fileno(stdin), _O_BINARY);
            auto state = color;
            std::thread([state] {
                ColorPacket packet;
                for (;;) {
                    size_t count = fread(&packet, 1, sizeof(packet), stdin);
                    if (!count) ExitProcess(0);
                    if (count != sizeof(packet) || memcmp(packet.magic, "HDC1", 4) || !packet.revision ||
                        packet.exposureTenths < -30 || packet.exposureTenths > 30 || packet.brightness < -50 || packet.brightness > 50) {
                        fprintf(stderr, "{\"type\":\"failed\",\"reason\":\"invalid_color_control\"}\n"); fflush(stderr); ExitProcess(1);
                    }
                    std::lock_guard<std::mutex> guard(state->mutex);
                    if (packet.revision <= state->revision) continue;
                    state->revision = packet.revision; state->exposureTenths = packet.exposureTenths; state->brightness = packet.brightness;
                }
            }).detach();
        }
        fprintf(stderr, "{\"type\":\"gpu-ready\",\"pixelReadback\":false,\"videoEncoders\":1}\n"); fflush(stderr);
        using clock = std::chrono::steady_clock;
        auto start = clock::now(), lastCheck = start;
        UINT frames = 0; bool haveFrame = false;
        while (!o.frames || frames < o.frames) {
            if (!o.synthetic) {
                bool fresh = captureFrame();
                if (fresh && !haveFrame) start = clock::now();
                haveFrame = fresh || haveFrame;
                if (!haveFrame) {
                    if (clock::now() - start > std::chrono::seconds(10)) throw std::runtime_error("capture_first_frame_timeout");
                    Sleep(1); continue;
                }
                if (clock::now() - lastCheck >= std::chrono::seconds(1)) { requireHdrOutput(); lastCheck = clock::now(); }
            }
            convert(frames); encode(frames);
            if (appliedRevision != reportedRevision) {
                reportedRevision = appliedRevision;
                fprintf(stderr, "{\"type\":\"color-applied\",\"revision\":%u,\"frame\":%u,\"exposureTenths\":%d,\"brightness\":%d}\n",
                    appliedRevision, frames, appliedExposure, appliedBrightness); fflush(stderr);
            }
            frames++;
            if (!o.synthetic || o.realtime) std::this_thread::sleep_until(start + std::chrono::nanoseconds(static_cast<UINT64>(frames) * 1000000000 / o.fps));
        }
        double seconds = std::chrono::duration<double>(clock::now() - start).count();
        fprintf(stderr, "{\"type\":\"gpu-complete\",\"frames\":%u,\"seconds\":%.6f,\"fps\":%.3f,\"encodedBytes\":%llu,\"pixelReadback\":false,\"videoEncoders\":1}\n",
            frames, seconds, frames / seconds, static_cast<unsigned long long>(encodedBytes)); fflush(stderr);
    }
};
int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    try { Pipeline(options(argc, argv)).run(); return 0; }
    catch (const std::exception& error) { fprintf(stderr, "{\"type\":\"failed\",\"reason\":\"%s\"}\n", error.what()); return 1; }
}
