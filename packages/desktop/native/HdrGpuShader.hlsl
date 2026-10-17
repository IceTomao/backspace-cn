// WGC FP16 scRGB (linear BT.709, 1 = 80 nit) -> limited-range BT.2020/PQ P010.
// Quantize only after the gamut and transfer transforms. No SDR intermediate.
cbuffer Parameters : register(b0) {
    uint Width, Height, SourceWidth, SourceHeight;
    uint FrameIndex, Pattern, Padding0, Padding1;
};
Texture2D<float4> Source : register(t0);
SamplerState LinearClamp : register(s0);
RWTexture2D<uint> Luma : register(u0);
RWTexture2D<uint2> Chroma : register(u1);

float3 pq(float3 scRgb) {
    float3 rgb2020 = float3(
        dot(scRgb, float3(0.627403896, 0.329283038, 0.043313066)),
        dot(scRgb, float3(0.069097289, 0.919540395, 0.011362316)),
        dot(scRgb, float3(0.016391439, 0.088013308, 0.895595253)));
    float3 p = pow(saturate(rgb2020 * (80.0 / 10000.0)), 2610.0 / 16384.0);
    return pow((3424.0 / 4096.0 + (2413.0 / 128.0) * p) /
        (1.0 + (2392.0 / 128.0) * p), 2523.0 / 32.0);
}
float3 samplePq(uint2 pixel) {
    // Aspect fit in linear light; bars remain absolute black.
    float scale = min(float(Width) / SourceWidth, float(Height) / SourceHeight);
    float2 content = float2(SourceWidth, SourceHeight) * scale;
    float2 position = float2(pixel) + 0.5 - (float2(Width, Height) - content) * 0.5;
    if (any(position < 0.0) || any(position >= content)) return 0.0;
    return pq(Source.SampleLevel(LinearClamp, position / content, 0).rgb);
}
float3 yuv(float3 rgb) {
    float y = dot(rgb, float3(0.2627, 0.6780, 0.0593));
    return float3(y, (rgb.b - y) / 1.8814, (rgb.r - y) / 1.4746);
}
[numthreads(8, 8, 1)]
void Convert(uint3 id : SV_DispatchThreadID) {
    uint2 p = id.xy * 2;
    if (p.x >= Width || p.y >= Height) return;
    float3 a = yuv(samplePq(p)), b = yuv(samplePq(p + uint2(1, 0)));
    float3 c = yuv(samplePq(p + uint2(0, 1))), d = yuv(samplePq(p + uint2(1, 1)));
    Luma[p] = uint(round(64.0 + 876.0 * saturate(a.x))) << 6;
    Luma[p + uint2(1, 0)] = uint(round(64.0 + 876.0 * saturate(b.x))) << 6;
    Luma[p + uint2(0, 1)] = uint(round(64.0 + 876.0 * saturate(c.x))) << 6;
    Luma[p + uint2(1, 1)] = uint(round(64.0 + 876.0 * saturate(d.x))) << 6;
    float2 uv = clamp((a.yz + b.yz + c.yz + d.yz) * 0.25, -0.5, 0.5);
    Chroma[id.xy] = uint2(round(512.0 + 896.0 * uv)) << 6;
}

// Generate the test input on the GPU too. Pattern 0 is the reference grey
// patches. Pattern 1 includes saturated HDR colors. Pattern 2 adds moving
// detail over most rows to exercise conversion/encoding beyond a still image.
RWTexture2D<float4> Synthetic : register(u0);
[numthreads(8, 8, 1)]
void Generate(uint3 id : SV_DispatchThreadID) {
    if (id.x >= SourceWidth || id.y >= SourceHeight) return;
    uint patch = min(3, id.x * 4 / SourceWidth);
    float value = patch == 0 ? 0 : patch == 1 ? 1 : patch == 2 ? 2.5 : 12.5;
    float3 rgb = value.xxx;
    if (Pattern == 1) {
        rgb = patch == 0 ? float3(4, 0, 0) : patch == 1 ? float3(0, 4, 0) :
              patch == 2 ? float3(0, 0, 4) : float3(-0.1, 2.5, 12.5);
    }
    if (Pattern == 2 && abs(int(id.y) - int(SourceHeight / 2)) > 8) {
        uint n = (id.x + FrameIndex * 3) * 1664525u + (id.y + FrameIndex) * 1013904223u;
        n ^= n >> 13; n *= 1274126177u; n ^= n >> 16;
        rgb *= 0.25 + float3(n & 255u, (n >> 8) & 255u, (n >> 16) & 255u) / 340.0;
    }
    Synthetic[id.xy] = float4(rgb, 1);
}
