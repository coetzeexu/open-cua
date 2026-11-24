import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod } from "node:fs/promises";

const exec = promisify(execFile);

/** Fixed scripts only; dynamic values travel through the child environment. */
export async function windowsScript(
  script: string,
  env: Record<string, string> = {},
) {
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop';" + script,
        "utf16le",
      ).toString("base64"),
    ],
    { env: { ...process.env, ...env }, timeout: 15000, windowsHide: true },
  );
  return stdout.trim();
}

/** chmod does not restrict Windows ACLs. Fail closed if user-only ACL setup fails. */
export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return chmod(directory, 0o700);
  await windowsScript(
    `
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:CUA_PRIVATE_DIRECTORY -AclObject $acl
  `,
    { CUA_PRIVATE_DIRECTORY: directory },
  );
}
