#pragma once
// Minimal WinRT ABI declarations for the inbox Windows capture APIs. These
// signatures/IIDs follow Microsoft's Windows SDK (win32metadata). Keeping the
// ABI here also permits a MinGW/Zig build without C++/WinRT projections.
#include <inspectable.h>
#include <roapi.h>
#include <winstring.h>

namespace wgc {
struct Size { INT32 Width, Height; };
struct __declspec(uuid("a37624ab-8d5f-4650-9d3e-9eae3d9bc670")) Device : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Trim() = 0;
};
struct __declspec(uuid("79c3f95b-31f7-4ec2-a464-632ef5d30760")) Item : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE DisplayName(HSTRING*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetSize(Size*) = 0;
    virtual HRESULT STDMETHODCALLTYPE AddClosed(IUnknown*, INT64*) = 0;
    virtual HRESULT STDMETHODCALLTYPE RemoveClosed(INT64) = 0;
};
struct __declspec(uuid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356")) ItemInterop : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE ForWindow(HWND, REFIID, void**) = 0;
    virtual HRESULT STDMETHODCALLTYPE ForMonitor(HMONITOR, REFIID, void**) = 0;
};
struct __declspec(uuid("fa50c623-38da-4b32-acf3-fa9734ad800e")) Frame : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Surface(IInspectable**) = 0;
    virtual HRESULT STDMETHODCALLTYPE SystemRelativeTime(INT64*) = 0;
    virtual HRESULT STDMETHODCALLTYPE ContentSize(Size*) = 0;
};
struct __declspec(uuid("814e42a9-f70f-4ad7-939b-fddcc6eb880d")) Session : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE StartCapture() = 0;
};
struct __declspec(uuid("24eb6d22-1975-422e-82e7-780dbd8ddf24")) Pool : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Recreate(IInspectable*, INT32, INT32, Size) = 0;
    virtual HRESULT STDMETHODCALLTYPE NextFrame(Frame**) = 0;
    virtual HRESULT STDMETHODCALLTYPE AddArrived(IUnknown*, INT64*) = 0;
    virtual HRESULT STDMETHODCALLTYPE RemoveArrived(INT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateSession(Item*, Session**) = 0;
    virtual HRESULT STDMETHODCALLTYPE DispatcherQueue(IInspectable**) = 0;
};
struct __declspec(uuid("589b103f-6bbc-5df5-a991-02e28b3b66d5")) PoolStatics : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE CreateFreeThreaded(IInspectable*, INT32, INT32, Size, Pool**) = 0;
};
struct __declspec(uuid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1")) DxgiAccess : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID, void**) = 0;
};
struct __declspec(uuid("30d5a829-7fa4-4026-83bb-d75bae4ea99e")) Closable : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Close() = 0;
};
}
#ifdef __CRT_UUID_DECL
__CRT_UUID_DECL(wgc::Device, 0xa37624ab,0x8d5f,0x4650,0x9d,0x3e,0x9e,0xae,0x3d,0x9b,0xc6,0x70)
__CRT_UUID_DECL(wgc::Item, 0x79c3f95b,0x31f7,0x4ec2,0xa4,0x64,0x63,0x2e,0xf5,0xd3,0x07,0x60)
__CRT_UUID_DECL(wgc::ItemInterop, 0x3628e81b,0x3cac,0x4c60,0xb7,0xf4,0x23,0xce,0x0e,0x0c,0x33,0x56)
__CRT_UUID_DECL(wgc::PoolStatics, 0x589b103f,0x6bbc,0x5df5,0xa9,0x91,0x02,0xe2,0x8b,0x3b,0x66,0xd5)
__CRT_UUID_DECL(wgc::DxgiAccess, 0xa9b3d012,0x3df2,0x4ee3,0xb8,0xd1,0x86,0x95,0xf4,0x57,0xd3,0xc1)
__CRT_UUID_DECL(wgc::Closable, 0x30d5a829,0x7fa4,0x4026,0x83,0xbb,0xd7,0x5b,0xae,0x4e,0xa9,0x9e)
#endif
