// IslaHelper — Agentic Island's tiny native Windows helper (~30 KB, ~10–20 MB RAM).
// Replaces the PowerShell helpers (60–85 MB each). Same line protocol as src/main/winhelper.ts:
//
// stdin:  "fg 1|0", "media 1|0", "bt 1|0", "mic 1|0", "mc toggle|next|prev", "ocr <png path>", "ocr 0",
//         "procs", "paste <pid>", "ping"
// stdout: "F:<process>\x1f<title>\x1f<pid>\x1f<l,t,r,b>"  foreground window changed
//         "R:<l,t,r,b>"                                    same window moved/resized
//         "M:<json>"                                       media state
//         "O:OK:<base64>" | "O:ERR:<message>"              OCR result (one per "ocr <path>")
//         "B:<json>"                                       Bluetooth devices + battery (on change)
//         "C:<app|app|…>"                                  apps using the microphone (on change)
//         "P:<json>"                                       AI-related processes (one per "procs")
//         "V:ok" | "V:fail"                                result of "paste <pid>"
//         "PONG"
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.x) — see scripts/build-helper.mjs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Control;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

static class IslaHelper {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);

  static readonly object OutLock = new object();
  static TextWriter Out;

  static void Emit(string s) {
    lock (OutLock) { Out.Write(s); Out.Write('\n'); Out.Flush(); }
  }

  /** Wait for a WinRT async operation (keeps this helper single-threaded and simple). */
  static R Wait<R>(IAsyncOperation<R> op) {
    while (op.Status == AsyncStatus.Started) Thread.Sleep(3);
    if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode != null ? op.ErrorCode.Message : "WinRT error");
    if (op.Status == AsyncStatus.Canceled) throw new Exception("canceled");
    return op.GetResults();
  }

  static string J(string s) {
    if (s == null) return "null";
    var b = new StringBuilder(s.Length + 8);
    b.Append('"');
    foreach (char c in s) {
      switch (c) {
        case '"': b.Append("\\\""); break;
        case '\\': b.Append("\\\\"); break;
        case '\n': b.Append("\\n"); break;
        case '\r': b.Append("\\r"); break;
        case '\t': b.Append("\\t"); break;
        default:
          if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
          else b.Append(c);
          break;
      }
    }
    b.Append('"');
    return b.ToString();
  }
  static string J(bool v) { return v ? "true" : "false"; }
  static string J(double v) { return v.ToString("R", System.Globalization.CultureInfo.InvariantCulture); }

  static readonly Queue<string> Commands = new Queue<string>();
  static bool InputClosed;

  static void Main() {
    var stdout = Console.OpenStandardOutput();
    Out = new StreamWriter(stdout, new UTF8Encoding(false));
    // Physical pixels, so the main process can map windows onto a screen capture.
    SetProcessDPIAware();
    var reader = new Thread(() => {
      var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string line;
      while ((line = stdin.ReadLine()) != null) lock (Commands) Commands.Enqueue(line);
      InputClosed = true;
    });
    reader.IsBackground = true;
    reader.Start();

    while (true) {
      while (true) {
        string cmd = null;
        lock (Commands) if (Commands.Count > 0) cmd = Commands.Dequeue();
        if (cmd == null) break;
        try { Handle(cmd); } catch (Exception e) { Emit("E:" + e.Message.Replace('\n', ' ')); }
      }
      // The app closed our stdin (it quit or restarted us) → exit.
      if (InputClosed) { lock (Commands) if (Commands.Count == 0) return; }
      var now = DateTime.UtcNow;
      if (fgOn && now >= fgNext) { fgNext = now.AddMilliseconds(1500); try { Foreground(); } catch { } }
      if (mediaOn && now >= mNext) { mNext = now.AddMilliseconds(700); try { Media(now); } catch (Exception e) { Emit("M:{\"error\":" + J(e.Message) + "}"); mKey = ""; mgr = null; } }
      if (btOn && now >= btNext) { btNext = now.AddSeconds(45); try { Bluetooth(); } catch { } }
      if (micOn && now >= micNext) { micNext = now.AddSeconds(3); try { Mic(); } catch { } }
      Thread.Sleep(120);
    }
  }

  static bool fgOn, mediaOn, btOn, micOn;
  static DateTime fgNext, mNext, btNext, micNext;

  static void Handle(string cmd) {
    if (cmd == "fg 1") { fgOn = true; fgKey = ""; fgNext = DateTime.MinValue; }
    else if (cmd == "fg 0") fgOn = false;
    else if (cmd == "media 1") { mediaOn = true; mKey = ""; mTrack = ""; mNext = DateTime.MinValue; }
    else if (cmd == "media 0") { mediaOn = false; thumb = null; mgr = null; }
    else if (cmd == "bt 1") { btOn = true; btNext = DateTime.MinValue; btLast = ""; }
    else if (cmd == "bt 0") btOn = false;
    else if (cmd == "mic 1") { micOn = true; micNext = DateTime.MinValue; micLast = "-"; }
    else if (cmd == "mic 0") micOn = false;
    else if (cmd == "ocr 0") { ocr = null; GC.Collect(); }
    else if (cmd.StartsWith("ocr ")) Ocr(cmd.Substring(4));
    else if (cmd.StartsWith("mc ")) MediaControl(cmd.Substring(3));
    else if (cmd == "procs") Procs();
    else if (cmd.StartsWith("paste ")) Paste(cmd.Substring(6));
    else if (cmd == "ping") Emit("PONG");
  }

  // ---------------------------------------------------------------- foreground window

  static string fgKey = "", fgRect = "", fgName = "";
  static uint fgPid;

  static void Foreground() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid != fgPid) {
      fgPid = pid;
      fgName = "";
      try { using (var p = Process.GetProcessById((int)pid)) fgName = p.ProcessName; } catch { }
    }
    RECT r;
    string rect = GetWindowRect(h, out r) ? r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom : "";
    string key = fgName + "\x1f" + sb + "\x1f" + pid;
    if (key != fgKey) { fgKey = key; fgRect = rect; Emit("F:" + key + "\x1f" + rect); }
    else if (rect != fgRect) { fgRect = rect; Emit("R:" + rect); }
  }

  // ---------------------------------------------------------------- media (Windows media session)

  static GlobalSystemMediaTransportControlsSessionManager mgr;
  static string mKey = "", mTrack = "", thumb;
  static DateTime mSent;

  static void Media(DateTime now) {
    if (mgr == null) mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
    var s = mgr.GetCurrentSession();
    if (s == null) {
      if (mKey != "none") { mKey = "none"; Emit("M:{\"none\":true}"); }
      return;
    }
    var p = Wait(s.TryGetMediaPropertiesAsync());
    var info = s.GetPlaybackInfo();
    var tl = s.GetTimelineProperties();
    string status = info.PlaybackStatus.ToString();
    string track = s.SourceAppUserModelId + "|" + p.Title + "|" + p.Artist;
    if (track != mTrack) {
      mTrack = track;
      thumb = null;
      if (p.Thumbnail != null) {
        try {
          var st = Wait(p.Thumbnail.OpenReadAsync());
          if (st.Size > 0 && st.Size < 600000) {
            var dr = new DataReader(st.GetInputStreamAt(0));
            uint n = Wait<uint>(dr.LoadAsync((uint)st.Size));
            var bytes = new byte[n];
            dr.ReadBytes(bytes);
            string type = bytes.Length > 0 && bytes[0] == 0xFF ? "image/jpeg" : bytes.Length > 0 && bytes[0] == 0x52 ? "image/webp" : "image/png";
            thumb = "data:" + type + ";base64," + Convert.ToBase64String(bytes);
          }
          st.Dispose();
        } catch { thumb = null; }
      }
    }
    var c = info.Controls;
    string key = track + "|" + status + "|" + c.IsNextEnabled + "|" + c.IsPreviousEnabled;
    if (key != mKey || (status == "Playing" && (now - mSent).TotalSeconds >= 5)) {
      // The thumbnail only travels when the track changes — not every 5 s while playing.
      bool sendThumb = key != mKey && (mKey == "" || !mKey.StartsWith(track + "|"));
      mKey = key;
      mSent = now;
      var o = new StringBuilder("{");
      o.Append("\"app\":").Append(J(s.SourceAppUserModelId ?? ""));
      o.Append(",\"title\":").Append(J(p.Title ?? ""));
      o.Append(",\"artist\":").Append(J(p.Artist ?? ""));
      o.Append(",\"album\":").Append(J(p.AlbumTitle ?? ""));
      o.Append(",\"status\":").Append(J(status));
      o.Append(",\"canToggle\":").Append(J(c.IsPlayPauseToggleEnabled));
      o.Append(",\"canNext\":").Append(J(c.IsNextEnabled));
      o.Append(",\"canPrev\":").Append(J(c.IsPreviousEnabled));
      o.Append(",\"position\":").Append(J(tl.Position.TotalSeconds));
      o.Append(",\"duration\":").Append(J(tl.EndTime.TotalSeconds));
      o.Append(",\"sameThumb\":").Append(J(!sendThumb));
      o.Append(",\"thumbnail\":").Append(sendThumb && thumb != null ? J(thumb) : "null");
      o.Append("}");
      Emit("M:" + o);
    }
  }

  static void MediaControl(string c) {
    if (!mediaOn || mgr == null) return;
    var s = mgr.GetCurrentSession();
    if (s == null) return;
    if (c == "toggle") Wait(s.TryTogglePlayPauseAsync());
    else if (c == "next") Wait(s.TrySkipNextAsync());
    else if (c == "prev") Wait(s.TrySkipPreviousAsync());
    mKey = "";
    mNext = DateTime.UtcNow.AddMilliseconds(150);
  }

  // ---------------------------------------------------------------- OCR (Windows.Media.Ocr)

  static OcrEngine ocr;

  static void Ocr(string path) {
    // Always answer exactly one line per request so the caller's queue stays in step.
    try {
      if (ocr == null) ocr = OcrEngine.TryCreateFromUserProfileLanguages();
      if (ocr == null) throw new Exception("No OCR language installed");
      var file = Wait(StorageFile.GetFileFromPathAsync(path));
      using (var stream = Wait(file.OpenAsync(FileAccessMode.Read))) {
        var decoder = Wait(BitmapDecoder.CreateAsync(stream));
        using (var bmp = Wait(decoder.GetSoftwareBitmapAsync())) {
          var result = Wait(ocr.RecognizeAsync(bmp));
          var sb = new StringBuilder();
          foreach (var l in result.Lines) { if (sb.Length > 0) sb.Append('\n'); sb.Append(l.Text); }
          Emit("O:OK:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString())));
        }
      }
    } catch (Exception e) {
      Emit("O:ERR:" + e.Message.Replace('\n', ' '));
    }
  }

  // ---------------------------------------------------------------- Bluetooth devices + battery

  static string btLast = "";
  const string P_CONNECTED = "{83DA6326-97A6-4088-9453-A1923F573B29} 15";
  const string P_BATTERY = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";
  const string P_ID = "System.Devices.DeviceInstanceId";
  static readonly Regex DevRe = new Regex(@"^(BTHENUM|BTHLE)\\DEV_([0-9A-F]{12})", RegexOptions.IgnoreCase);
  static readonly Regex AudioRe = new Regex(@"\{0000(110B|111E|1108|110D|1203)-", RegexOptions.IgnoreCase);

  static void Bluetooth() {
    // Device nodes (not interfaces) under the Bluetooth enumerators, like Get-PnpDevice does.
    var all = Wait(DeviceInformation.FindAllAsync(
      "System.Devices.DeviceInstanceId:~<\"BTHENUM\" OR System.Devices.DeviceInstanceId:~<\"BTHLE\"",
      new[] { P_ID, P_CONNECTED, P_BATTERY },
      DeviceInformationKind.Device));
    var nodes = new List<KeyValuePair<string, DeviceInformation>>();
    foreach (var d in all) {
      object id;
      if (d.Properties.TryGetValue(P_ID, out id) && id != null) nodes.Add(new KeyValuePair<string, DeviceInformation>(id.ToString(), d));
    }
    var o = new StringBuilder("[");
    bool first = true;
    foreach (var n in nodes) {
      var m = DevRe.Match(n.Key);
      if (!m.Success) continue;
      object con;
      // "Connected" is only reliable on the device node itself.
      if (!n.Value.Properties.TryGetValue(P_CONNECTED, out con) || !(con is bool) || !(bool)con) continue;
      string mac = m.Groups[2].Value;
      string bat = "null";
      bool audio = false;
      foreach (var r in nodes) {
        if (r.Key.IndexOf(mac, StringComparison.OrdinalIgnoreCase) < 0) continue;
        object b;
        // The battery lives on a sibling node (e.g. "Hands-Free AG") that shares the device's address.
        if (bat == "null" && r.Value.Properties.TryGetValue(P_BATTERY, out b) && b != null) bat = Convert.ToInt32(b).ToString();
        if (AudioRe.IsMatch(r.Key)) audio = true;
      }
      if (!first) o.Append(',');
      first = false;
      o.Append("{\"name\":").Append(J(n.Value.Name ?? "")).Append(",\"battery\":").Append(bat).Append(",\"audio\":").Append(J(audio)).Append('}');
    }
    o.Append(']');
    string j = o.ToString();
    if (j != btLast) { btLast = j; Emit("B:" + j); }
  }

  // ---------------------------------------------------------------- microphone in use (meeting detection)

  static string micLast = "-";
  const string MicBase = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

  static bool InUse(RegistryKey k) {
    object a = k.GetValue("LastUsedTimeStart"), b = k.GetValue("LastUsedTimeStop");
    return a != null && b != null && Convert.ToInt64(a) > 0 && Convert.ToInt64(b) == 0;
  }

  static void Mic() {
    var list = new List<string>();
    using (var root = Registry.CurrentUser.OpenSubKey(MicBase)) {
      if (root != null) {
        foreach (var name in root.GetSubKeyNames()) {
          using (var k = root.OpenSubKey(name)) {
            if (k == null) continue;
            if (name == "NonPackaged") {
              foreach (var sub in k.GetSubKeyNames()) using (var s = k.OpenSubKey(sub)) if (s != null && InUse(s)) list.Add(sub);
            } else if (InUse(k)) list.Add(name);
          }
        }
      }
    }
    list.Sort(StringComparer.Ordinal);
    string s2 = string.Join("|", list.ToArray());
    if (s2 != micLast) { micLast = s2; Emit("C:" + s2); }
  }

  // ---------------------------------------------------------------- AI processes (Usage tab)

  static readonly Regex AiProc = new Regex(@"^(claude|codex|gemini|antigravity|cursor|windsurf|kiro|ollama|ollama app|lm studio|chatgpt|node|language_server_windows_x64)\.exe$", RegexOptions.IgnoreCase);

  static void Procs() {
    var o = new StringBuilder("[");
    bool first = true;
    try {
      using (var q = new ManagementObjectSearcher("SELECT Name, ProcessId, CommandLine, ExecutablePath, WorkingSetSize, KernelModeTime, UserModeTime FROM Win32_Process")) {
        foreach (ManagementObject p in q.Get()) {
          using (p) {
            string name = (p["Name"] ?? "").ToString();
            if (!AiProc.IsMatch(name)) continue;
            if (!first) o.Append(',');
            first = false;
            ulong w = p["WorkingSetSize"] != null ? Convert.ToUInt64(p["WorkingSetSize"]) : 0;
            ulong t = (p["KernelModeTime"] != null ? Convert.ToUInt64(p["KernelModeTime"]) : 0) + (p["UserModeTime"] != null ? Convert.ToUInt64(p["UserModeTime"]) : 0);
            o.Append("{\"n\":").Append(J(name))
              .Append(",\"p\":").Append(p["ProcessId"])
              .Append(",\"c\":").Append(J((p["CommandLine"] ?? "").ToString()))
              .Append(",\"e\":").Append(J((p["ExecutablePath"] ?? "").ToString()))
              .Append(",\"w\":").Append(w)
              .Append(",\"t\":").Append(t)
              .Append('}');
          }
        }
      }
    } catch { }
    o.Append(']');
    Emit("P:" + o);
  }

  // ---------------------------------------------------------------- paste into an app (never presses Enter)

  const byte VK_CONTROL = 0x11, VK_V = 0x56;
  const uint KEYUP = 0x2;

  static void Paste(string pidText) {
    int pid;
    if (!int.TryParse(pidText.Trim(), out pid)) { Emit("V:fail"); return; }
    try {
      using (var p = Process.GetProcessById(pid)) {
        IntPtr h = p.MainWindowHandle;
        if (h == IntPtr.Zero) { Emit("V:fail"); return; }
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        AllowSetForegroundWindow(pid);
        if (!SetForegroundWindow(h)) { Emit("V:fail"); return; }
        Thread.Sleep(350);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
        Emit("V:ok");
      }
    } catch { Emit("V:fail"); }
  }
}
