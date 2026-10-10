using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DllProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryW(string p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryExW(string p, IntPtr h, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr GetModuleHandleW(string n);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetModuleFileNameW(IntPtr h, StringBuilder s, uint n);

    public static string Where(string name)
    {
        IntPtr h = GetModuleHandleW(name);
        if (h == IntPtr.Zero) return "(not loaded)";
        var sb = new StringBuilder(1024);
        GetModuleFileNameW(h, sb, 1024);
        return sb.ToString();
    }

    public static string Load(string path)
    {
        IntPtr h = LoadLibraryW(path);
        return h == IntPtr.Zero ? "FAILED err=" + Marshal.GetLastWin32Error() : "ok";
    }

    public static string LoadEx(string path, uint flags)
    {
        IntPtr h = LoadLibraryExW(path, IntPtr.Zero, flags);
        return h == IntPtr.Zero ? "FAILED err=" + Marshal.GetLastWin32Error() : "ok";
    }
}
