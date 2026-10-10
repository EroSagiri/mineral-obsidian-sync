// Minimal Node-loadable shim whose only job is to map the bundled ONNX Runtime by absolute path
// before the sherpa-onnx addon (whose import of "onnxruntime.dll" is resolved by name) is loaded.
//
//   cl /nologo /LD /Fe:ort-preload.dll ort-preload.cpp
//   copy ort-preload.dll ort-preload.node
//   node -e "process.dlopen({exports:{}}, 'ort-preload.node')"
//
// The bundled path can be overridden with the DSH_ORT_PRELOAD environment variable.
#include <windows.h>
#include <string>

static void PreloadOrt() {
    wchar_t fromEnv[32768];
    DWORD n = GetEnvironmentVariableW(L"DSH_ORT_PRELOAD", fromEnv, 32768);
    if (n > 0 && n < 32768) {
        LoadLibraryW(fromEnv);
        return;
    }
    // Default: the copy that ships inside the DeepSeek Harness installation.
    LoadLibraryW(
        L"C:\\Users\\i\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar.unpacked"
        L"\\dsh\\node_modules\\sherpa-onnx-win-x64\\onnxruntime.dll");
}

extern "C" __declspec(dllexport) void* napi_register_module_v1(void* env, void* exports) {
    PreloadOrt();
    return exports;
}

extern "C" __declspec(dllexport) void node_module_register(void* mod) {
    (void)mod;
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID reserved) {
    (void)module;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        PreloadOrt();
    }
    return TRUE;
}
