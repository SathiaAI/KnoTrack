// Shared test helper: generates a real, freshly-minted self-signed X.509
// certificate PEM at test time (not a fixed committed one) for tests that
// need actual valid certificate bytes — e.g. the strict X509Certificate-based
// validation in src/db/ssl-config.ts rejects placeholder text like
// "-----BEGIN CERTIFICATE-----\nfakecertdata\n-----END CERTIFICATE-----\n".
// Only the certificate, never a private key, is returned or retained.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function generateTestCertificatePem(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'knotrack-test-cert-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=knotrack-test-cert',
    ]);
    return readFileSync(certPath, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
