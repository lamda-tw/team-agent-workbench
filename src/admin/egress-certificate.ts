import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, X509Certificate } from 'node:crypto';
import { atomicJson } from '../core/store';

const exec = promisify(execFile);
type CertificateFiles = { pfx: string; cer: string; password: string };

export async function ensureEgressCertificate(root: string) {
  const metadata = path.join(root, 'egress-certificate.json');
  let files: CertificateFiles | undefined;
  try { files = JSON.parse(await fs.readFile(metadata, 'utf8')); } catch {}
  if (!files || !(await fs.stat(files.pfx).catch(() => undefined))?.isFile() || !(await fs.stat(files.cer).catch(() => undefined))?.isFile()) {
    if (process.platform !== 'win32') throw new Error('网络出口证书自动生成目前仅支持 Windows');
    await fs.mkdir(root, { recursive: true });
    files = { pfx: path.join(root, 'egress-certificate.pfx'), cer: path.join(root, 'egress-certificate.cer'), password: randomBytes(24).toString('base64url') };
    const script = `Import-Module PKI; $ErrorActionPreference='Stop'; $cert=New-SelfSignedCertificate -Subject 'CN=Team Agent Egress' -DnsName @('localhost',$env:COMPUTERNAME) -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5); $pwd=ConvertTo-SecureString -String $env:TEAM_AGENT_CERT_PASSWORD -Force -AsPlainText; Export-PfxCertificate -Cert $cert -FilePath $env:TEAM_AGENT_PFX -Password $pwd | Out-Null; Export-Certificate -Cert $cert -FilePath $env:TEAM_AGENT_CER -Type CERT | Out-Null; Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\'+$cert.Thumbprint) -Force`;
    const environment: NodeJS.ProcessEnv = { ...process.env, TEAM_AGENT_PFX: files.pfx, TEAM_AGENT_CER: files.cer, TEAM_AGENT_CERT_PASSWORD: files.password };
    delete environment.PSModulePath;
    await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: environment });
    await atomicJson(metadata, files);
  }
  const pfx = await fs.readFile(files.pfx), certificate = new X509Certificate(await fs.readFile(files.cer));
  return { pfx, passphrase: files.password, fingerprint: certificate.fingerprint256.replace(/:/g, '').toUpperCase() };
}
