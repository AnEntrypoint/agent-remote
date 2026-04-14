#!/usr/bin/env node
// Windows debloat + software installation tool
// Run as Administrator: debloat.exe
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const NAS_X64 = String.raw`\\192.168.0.101\Dropbox\x64`;
const LOCAL_X64 = String.raw`C:\x64`;

// ── UWP apps to remove ──────────────────────────────────────────────────────

const REMOVE_APPS = [
  "McAfeeWPSSparsePackage",
  "Microsoft.BingSearch",
  "Microsoft.BingNews",
  "Microsoft.BingWeather",
  "Clipchamp.Clipchamp",
  "Microsoft.MicrosoftSolitaireCollection",
  "Microsoft.WindowsFeedbackHub",
  "Microsoft.GamingApp",
  "Microsoft.GetHelp",
  "Microsoft.MicrosoftJournal",
  "Microsoft.ZuneMusic",
  "Microsoft.MicrosoftOfficeHub",
  "Microsoft.PowerAutomateDesktop",
  "Microsoft.Todos",
  "Microsoft.Whiteboard",
  "Microsoft.XboxGamingOverlay",
  "Microsoft.XboxIdentityProvider",
  "Microsoft.XboxSpeechToTextOverlay",
  "Microsoft.Xbox.TCUI",
  "Microsoft.YourPhone",
  "Microsoft.Copilot",
  "MSTeams",
  "E046963F.LenovoCompanion",
  "MicrosoftWindows.Client.WebExperience",
  "Microsoft.OutlookForWindows",
  "Microsoft.Edge.GameAssist",
  "Microsoft.Windows.DevHome",
  "MicrosoftCorporationII.MicrosoftFamily",
  "Microsoft.Office.OneNote",
];

// ── Win32 programs to uninstall via winget ───────────────────────────────────

const WINGET_UNINSTALL = [
  "McAfee",
  "WebAdvisor by McAfee",
  "Lenovo Vantage",
  "Lenovo Now",
];

// ── Services to disable ─────────────────────────────────────────────────────

const DISABLE_SERVICES = ["DiagTrack", "SysMain", "WSearch"];

// ── Registry tweaks ─────────────────────────────────────────────────────────

const REGISTRY_TWEAKS = [
  { desc: "Disable Xbox Game Bar", cmd: `Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name AppCaptureEnabled -Value 0 -Force -EA SilentlyContinue; Set-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name GameDVR_Enabled -Value 0 -Force -EA SilentlyContinue` },
  { desc: "Disable Hibernate", cmd: `powercfg /h off` },
  { desc: "Disable startup delay", cmd: `New-Item -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize' -Force -EA SilentlyContinue | Out-Null; Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize' -Name StartupDelayInMSec -Value 0 -Force` },
  { desc: "Disable Tips/Suggestions", cmd: `Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name SubscribedContent-338389Enabled -Value 0 -Force -EA SilentlyContinue` },
  { desc: "Disable Advertising ID", cmd: `Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo' -Name Enabled -Value 0 -Force -EA SilentlyContinue` },
  { desc: "Visual effects: best performance", cmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Value 2 -Force -EA SilentlyContinue` },
  { desc: "Disable Copilot (policy)", cmd: `New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot' -Force -EA SilentlyContinue | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot' -Name TurnOffWindowsCopilot -Value 1 -Force` },
  { desc: "Disable OneDrive startup", cmd: `Remove-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' -Name OneDrive -Force -EA SilentlyContinue` },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function ps(cmd) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
  });
}

function run(label, cmd) {
  process.stdout.write(label + " ... ");
  const r = ps(cmd);
  if (r.status === 0) { console.log("OK"); return true; }
  console.log("SKIP");
  return false;
}

function cmd(args) {
  return spawnSync("cmd.exe", ["/c", ...args], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 300000,
  });
}

// ── Phase 1: Remove UWP bloatware ────────────────────────────────────────────

function removeUWPApps() {
  console.log("\n=== Removing UWP bloatware ===\n");
  let ok = 0;
  for (let i = 0; i < REMOVE_APPS.length; i++) {
    const pkg = REMOVE_APPS[i];
    if (run(`[${i + 1}/${REMOVE_APPS.length}] ${pkg}`,
      `Get-AppxProvisionedPackage -Online -EA SilentlyContinue | Where-Object { $_.DisplayName -like '*${pkg}*' } | Remove-AppxProvisionedPackage -Online -EA SilentlyContinue; Get-AppxPackage -AllUsers *${pkg}* | Remove-AppxPackage -AllUsers -ErrorAction Stop`)) ok++;
  }
  console.log(`\n${ok}/${REMOVE_APPS.length} removed`);
}

// ── Phase 2: Uninstall Win32 programs ────────────────────────────────────────

function uninstallWin32() {
  console.log("\n=== Uninstalling Win32 bloatware ===\n");

  // Remove OneNote via ClickToRun (blocks Office install)
  const c2r = String.raw`C:\Program Files\Common Files\Microsoft Shared\ClickToRun\OfficeClickToRun.exe`;
  if (existsSync(c2r)) {
    // Remove OneNote Free
    process.stdout.write("  OneNote (ClickToRun) ... ");
    const r = spawnSync(c2r, [
      "scenario=install", "scenariosubtype=ARP", "sourcetype=None",
      "productstoremove=OneNoteFreeRetail.16_en-us_x-none",
      "culture=en-us", "version.16=16.0", "DisplayLevel=False"
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    console.log(r.status === 0 ? "OK" : "SKIP (exit " + r.status + ")");

    // Remove MS 365
    process.stdout.write("  Microsoft 365 ... ");
    const r2 = spawnSync(c2r, [
      "scenario=install", "scenariosubtype=ARP", "sourcetype=None",
      "productstoremove=AllProducts", "DisplayLevel=False"
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    console.log(r2.status === 0 ? "OK" : "SKIP (exit " + r2.status + ")");
  }

  // Winget uninstalls
  for (const name of WINGET_UNINSTALL) {
    process.stdout.write(`  ${name} (winget) ... `);
    const r = spawnSync("winget", ["uninstall", "--name", name, "--silent", "--accept-source-agreements"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
    });
    const out = r.stdout?.toString() || "";
    if (out.includes("Successfully") || out.includes("No installed")) console.log("OK");
    else console.log("SKIP");
  }

  // OneDrive
  process.stdout.write("  OneDrive ... ");
  spawnSync("taskkill", ["/f", "/im", "OneDrive.exe"], { stdio: "ignore" });
  const sysroot = process.env.SystemRoot || String.raw`C:\Windows`;
  const odPaths = [
    String.raw`${sysroot}\SysWOW64\OneDriveSetup.exe`,
    String.raw`${sysroot}\System32\OneDriveSetup.exe`,
  ];
  let odDone = false;
  for (const p of odPaths) {
    if (existsSync(p)) {
      spawnSync(p, ["/uninstall"], { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
      odDone = true;
      break;
    }
  }
  console.log(odDone ? "OK" : "SKIP");
}

// ── Phase 3: Disable services ────────────────────────────────────────────────

function disableServices() {
  console.log("\n=== Disabling services ===\n");
  for (const svc of DISABLE_SERVICES) {
    run(`  ${svc}`, `Stop-Service ${svc} -Force -EA SilentlyContinue; Set-Service ${svc} -StartupType Disabled -EA SilentlyContinue`);
  }
}

// ── Phase 4: Registry tweaks ─────────────────────────────────────────────────

function applyRegistryTweaks() {
  console.log("\n=== Applying registry tweaks ===\n");
  for (const t of REGISTRY_TWEAKS) {
    run(`  ${t.desc}`, t.cmd);
  }
}

// ── Phase 5: Copy installers & install software ──────────────────────────────

function installSoftware() {
  console.log("\n=== Installing software ===\n");

  // Test NAS access
  console.log(`  Testing access to ${NAS_X64} ...`);
  const dirTest = cmd([`dir ${NAS_X64}`]);
  if (dirTest.status !== 0) {
    console.log("  NAS not accessible, trying net use ...");
    const net = spawnSync("cmd.exe", ["/c", String.raw`net use \\192.168.0.101\Dropbox`], {
      stdio: "inherit", timeout: 30000,
    });
    if (net.status !== 0) {
      console.log(String.raw`  ERROR: Cannot access NAS. Run: net use \\192.168.0.101\Dropbox /user:USERNAME PASSWORD`);
      console.log("  Skipping software installation.");
      return;
    }
  }
  console.log("  NAS accessible");

  // Copy x64 from NAS (no quotes around UNC paths!)
  process.stdout.write(`  Copying ${NAS_X64} to ${LOCAL_X64} ... `);
  const copy = cmd([`xcopy ${NAS_X64} ${LOCAL_X64} /E /I /Y`]);
  const copyOut = copy.stdout?.toString().trim();
  const copyErr = copy.stderr?.toString().trim();
  if (copy.status === 0) { console.log("OK" + (copyOut ? " (" + copyOut.split("\n").pop().trim() + ")" : "")); }
  else { console.log("FAIL: " + (copyErr || copyOut || "exit " + copy.status)); }

  if (!existsSync(LOCAL_X64)) {
    console.log("  ERROR: C:\\x64 not found, skipping installs");
    return;
  }

  // Install Acrobat Reader
  const acrobat = String.raw`C:\x64\AcroRdrDC2200120117_en_US.exe`;
  if (existsSync(acrobat)) {
    process.stdout.write("  Acrobat Reader DC ... ");
    const r = spawnSync(acrobat, ["/sAll", "/rs", "/msi", "EULA_ACCEPT=YES"], {
      stdio: "inherit", timeout: 300000,
    });
    console.log(r.status === 0 ? "OK" : "FAIL (exit " + r.status + ")");
  } else { console.log("  Acrobat Reader DC ... NOT FOUND"); }

  // Install Chrome
  const chrome = String.raw`C:\x64\ChromeSetup.exe`;
  if (existsSync(chrome)) {
    process.stdout.write("  Google Chrome ... ");
    const r = spawnSync(chrome, ["/silent", "/install"], {
      stdio: "inherit", timeout: 300000,
    });
    console.log(r.status === 0 ? "OK" : "FAIL (exit " + r.status + ")");
  } else { console.log("  Google Chrome ... NOT FOUND"); }

  // Install Office ProPlus 2021
  const setup = String.raw`C:\x64\Office\setup.exe`;
  const xml = String.raw`C:\x64\Office\ProPlus.xml`;
  if (existsSync(setup) && existsSync(xml)) {
    process.stdout.write("  Office ProPlus 2021 ... ");
    const r = spawnSync(setup, ["/configure", xml], {
      stdio: "inherit", timeout: 600000,
    });
    console.log(r.status === 0 ? "OK" : "FAIL (exit " + r.status + ")");
  } else { console.log("  Office ProPlus 2021 ... NOT FOUND"); }
}

// ── main ─────────────────────────────────────────────────────────────────────

// Self-elevate if not admin
const isAdmin = spawnSync("powershell.exe", ["-NoProfile", "-Command",
  "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
  { stdio: ["ignore", "pipe", "pipe"] }).stdout.toString().trim();
if (isAdmin !== "True") {
  console.log("Not running as admin, relaunching elevated...");
  spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `Start-Process -FilePath '${process.execPath}' -Verb RunAs -Wait`],
    { stdio: "inherit" });
  process.exit(0);
}

console.log("=== Windows Debloat Tool ===");
console.log("Machine: " + (execSync("hostname").toString().trim()));
console.log("Running as Administrator\n");

removeUWPApps();
uninstallWin32();
disableServices();
applyRegistryTweaks();
installSoftware();

console.log("\n=== DEBLOAT COMPLETE ===");
console.log("Restart recommended.\n");
spawnSync("cmd.exe", ["/c", "pause"], { stdio: "inherit" });
