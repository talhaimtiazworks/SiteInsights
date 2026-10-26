#!/usr/bin/env python3
"""Package the complete SiteInsights source tree, never its credentials or build output.
Run: python3 scripts/package-release.py [--output /path/to/SiteInsights-TalhaImtiazWorks-Redesign.zip]
No third-party Python dependencies and no Git checkout are required.
"""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', '.next', '.vercel', '.cache', '.local', '.npm', '.venv', 'node_modules', '__pycache__', 'coverage', 'build', 'dist', 'out', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo', '.arena', 'target', '.nox', '.nuxt', '.output', '.parcel-cache', '.svelte-kit', '.tox', '.vite', 'test-results', 'playwright-report'}
SKIP_FILES = {'next-env.d.ts', '.DS_Store', '.npmrc', '.netrc', '.git-credentials', '.envrc', 'credentials.json', 'storage-state.json', 'auth-state.json'}
SKIP_SUFFIXES = {'.log', '.zip', '.tsbuildinfo', '.pyc', '.pem', '.key', '.p12', '.pfx', '.bak', '.tmp', '.kdbx', '.jks', '.keystore', '.env'}
ESSENTIAL = {
    'README.md', 'AGENTS.md', 'CHANGELOG.md', 'config/environment.example.txt', '.gitignore', '.nvmrc',
    'package.json', 'package-lock.json', 'worker/package.json', 'worker/package-lock.json',
    'next.config.ts', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.mjs', 'eslint.config.mjs', 'vercel.json', 'vitest.config.ts',
    'worker/Dockerfile', 'worker/tsconfig.json', 'worker/src/main.ts',
    'src/app/layout.tsx', 'src/app/page.tsx', 'src/app/about/page.tsx', 'src/app/manifest.ts', 'src/app/robots.ts', 'src/app/sitemap.ts',
    'src/lib/design-tokens.json', 'src/app/brand-tokens.css', 'src/components/branded-loading.tsx', 'src/lib/auth/audit-policy.ts', 'docs/REDESIGN.md',
    'public/brand/talhaimtiazworks-logo.png', 'public/brand/talhaimtiazworks-logo-160.png', 'public/brand/talhaimtiazworks-logo-320.png', 'public/brand/talhaimtiazworks-logo-640.png', 'public/brand/official-logo.json',
    'scripts/brand/fonts/NotoSansArabic.ttf', 'scripts/brand/fonts/NotoEmoji.ttf', 'scripts/brand/fonts/NotoSansSC.ttf', 'scripts/brand/fonts/NotoSansKR.ttf', 'scripts/brand/fonts/NotoSansKR-OFL.txt', 'scripts/brand/fonts/provenance.json', 'scripts/brand/prepare-fonts.py', 'scripts/brand/fonts/NotoSansArabic-OFL.txt', 'scripts/brand/fonts/NotoSansSC-OFL.txt', 'scripts/brand/fonts/Noto-OFL.txt',
    'tests/mandatory-auth.test.ts', 'tests/brand-system.test.ts', 'tests/helpers/auth-fixture.ts', 'scripts/smoke/redesign.mjs', 'scripts/smoke/loading.mjs', 'scripts/smoke/pdf-layout.mts', 'docs/verification/test-summary.json', 'docs/verification/authenticated-browser.json', 'docs/verification/pdf-layout.json',
    'src/lib/brand.ts', 'src/lib/config/metadata.ts', 'src/lib/db/migrations.ts', 'db/supabase-setup.sql',
    'docs/REBRAND.md', 'docs/RELEASE-VERIFICATION.md', 'docs/SUPABASE.md', 'docs/DEPLOYMENT.md', 'docs/ENVIRONMENT.md',
    'public/brand/siteinsight-logo.svg', 'public/brand/siteinsight-logo-dark.svg', 'public/brand/siteinsight-logo-mono.svg',
    'public/brand/siteinsight-mark.svg', 'public/brand/siteinsight-mark-mono.svg', 'public/brand/siteinsight-icon.svg',
    'public/brand/icon-192.png', 'public/brand/icon-512.png', 'public/favicon.svg',
    'src/app/icon.svg', 'src/app/favicon.ico', 'src/app/apple-icon.png', 'src/app/opengraph-image.png', 'src/app/twitter-image.png',
    'src/app/opengraph-image.alt.txt', 'src/app/twitter-image.alt.txt',
    'supabase/templates/subjects.json', 'supabase/templates/confirmation.html', 'supabase/templates/recovery.html',
    'supabase/templates/text/confirmation.txt', 'supabase/templates/text/recovery.txt',
    'scripts/brand/generate.py', 'scripts/brand/wordmark.json', 'scripts/brand/InterVariable.ttf', 'scripts/brand/Inter-OFL.txt',
    'tests/branding.test.ts', 'tests/email-templates.test.ts', 'tests/pdf-report.test.ts',
    'scripts/package-release.py', 'docs/MAILJET-SMTP.md', 'docs/GMAIL-SMTP.md', 'docs/TESTING.md', 'docs/REBRAND-VERIFICATION.md',
    'tests/fixtures/mailjet-smtp.ts',
    'scripts/email/smtp-config.mjs', 'scripts/email/smtp-config.d.mts',
    'scripts/email/smtp-service.mjs', 'scripts/email/smtp-service.d.mts',
    'scripts/email/check-smtp.mjs', 'scripts/email/check-smtp.d.mts',
    'scripts/email/check-client-boundary.mjs', 'scripts/email/check-client-boundary.d.mts',
    'scripts/supabase/auth-config-lib.mjs', 'scripts/supabase/configure-auth.mjs', 'scripts/supabase/configure-auth.d.mts',
    'tests/smtp.test.ts', 'tests/smtp-supabase-security.test.ts', 'tests/smtp-auth-boundaries.test.ts', 'tests/smtp-client-build.test.ts',
    'tests/supabase-auth-config.test.ts', 'tests/logger-redaction.test.ts', 'tests/accounts-unit.test.ts',
    # Provider-derived avatars, profile/session API boundaries, and the preserved optional legacy migration.
    'db/optional/007_avatar_storage.sql', 'src/lib/avatar.ts', 'src/lib/auth/server.ts', 'src/lib/auth/session-provider.ts', 'src/lib/auth/page-guard.ts',
    'src/app/api/auth/oauth/route.ts', 'src/app/auth/callback/route.ts', 'src/app/api/auth/session/route.ts',
    'src/app/api/auth/sign-in/route.ts', 'src/app/api/auth/sign-up/route.ts', 'src/app/api/auth/sign-out/route.ts',
    'src/app/api/account/route.ts', 'src/app/api/account/profile/route.ts',
    'src/app/account/(settings)/profile/profile-client.tsx', 'src/components/account-menu.tsx',
    'tests/avatar.test.ts', 'tests/auth-avatar.test.ts', 'tests/session-provider.test.ts', 'tests/oauth-provider-flow.test.ts', 'tests/profile-avatar.test.ts', 'tests/sign-out.test.ts',
    'scripts/smoke/oauth-e2e.mjs',
    'src/lib/config/env.ts', 'src/lib/services/diagnostics.ts',
    'docs/SUPABASE.md', 'docs/DEPLOYMENT.md', 'docs/ENVIRONMENT.md', 'docs/TESTING.md',
    # Plans, credits, billing, prospects and the product typefaces.
    'db/migrations/006_plans_credits_prospects.sql', 'src/lib/billing/plans.ts', 'src/lib/billing/reducer.ts', 'src/lib/billing/registry.ts',
    'src/lib/billing/service.ts', 'src/lib/credits/service.ts', 'src/lib/usage/entitlements.ts', 'src/lib/leads/opportunity.ts',
    'scripts/billing/manage-subscription.mjs', 'docs/BILLING.md', 'src/app/admin/analytics/page.tsx', 'src/lib/admin/allowlist.ts', 'src/app/api/analytics/track/route.ts', 'docs/ANALYTICS.md', 'db/migrations/011_analytics.sql', 'src/app/features/page.tsx',
    'src/app/fonts/BricolageGrotesque.woff2', 'src/app/fonts/Inter.woff2', 'src/app/fonts/JetBrainsMono.woff2', 'src/app/fonts/provenance.json',
    'scripts/brand/fonts/ui/Inter-Regular.ttf', 'scripts/brand/fonts/ui/Inter-SemiBold.ttf', 'scripts/brand/fonts/ui/BricolageGrotesque-SemiBold.ttf',
    'scripts/brand/fonts/ui/JetBrainsMono-Regular.ttf', 'scripts/brand/fonts/ui/provenance.json', 'scripts/brand/prepare-ui-fonts.py',
    'tests/crawler-scale.test.ts', 'tests/plans-credits.test.ts', 'tests/billing-unit.test.ts', 'tests/billing.integration.test.ts', 'tests/helpers/pdf-text.ts',
}

def distributable(relative: Path) -> bool:
    if any(part in SKIP_DIRS for part in relative.parts):
        return False
    name = relative.name
    if any(part.lower().startswith('.env') or '.env.' in part.lower() for part in relative.parts):
        return False
    return name not in SKIP_FILES and relative.suffix.lower() not in SKIP_SUFFIXES and not name.endswith('.zip.sha256')

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parent / 'SiteInsights-TalhaImtiazWorks-Redesign.zip')
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and distributable(p.relative_to(ROOT)))
    if any(p.is_symlink() for p in files):
        raise RuntimeError('Symlinks are not accepted in the release archive')
    relative_names = {p.relative_to(ROOT).as_posix() for p in files}
    missing = ESSENTIAL - relative_names
    if missing:
        raise RuntimeError(f'Missing essential source files: {sorted(missing)}')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in files:
            archive.write(file, f'SiteInsights/{file.relative_to(ROOT).as_posix()}')
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError('ZIP was not created or is empty')
    with zipfile.ZipFile(output) as archive:
        if bad := archive.testzip():
            raise RuntimeError(f'ZIP CRC failure: {bad}')
        names = archive.namelist()
        if len(names) != len(set(names)) or len(names) != len(files):
            raise RuntimeError('Archive has duplicate or missing entries')
        for name in names:
            pure = PurePosixPath(name)
            if pure.is_absolute() or '..' in pure.parts or pure.parts[0] != 'SiteInsights' or '\\' in name:
                raise RuntimeError(f'Unsafe archive path: {name}')
            relative = Path(*pure.parts[1:])
            if not distributable(relative):
                raise RuntimeError(f'Sensitive/generated file in archive: {name}')
        # Independent extraction + byte-for-byte SHA-256 comparison of every source file.
        with tempfile.TemporaryDirectory(prefix='siteinsight-zip-verify-') as temp:
            archive.extractall(temp)
            for file in files:
                relative = file.relative_to(ROOT)
                extracted = Path(temp) / 'SiteInsights' / relative
                if not extracted.is_file() or digest(file.read_bytes()) != digest(extracted.read_bytes()):
                    raise RuntimeError(f'Extracted content mismatch: {relative}')
    sha = digest(output.read_bytes())
    output.with_name(output.name + '.sha256').write_text(f'{sha}  {output.name}\n')
    print(f'Created: {output}')
    print(f'Size: {output.stat().st_size:,} bytes; source files: {len(files)}')
    print(f'Verified: ZIP CRC, safe paths, {len(ESSENTIAL)} essential files, credential/build exclusions, independent extraction and all-file SHA-256 parity')
    print(f'SHA-256: {sha}')

if __name__ == '__main__':
    main()
