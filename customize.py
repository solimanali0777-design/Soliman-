#!/usr/bin/env python3
"""Safe, fail-fast Soly Cut branding. Keep ClearCut third-party notices."""
from pathlib import Path
import re
import sys
root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('.')
gradle = root / 'app' / 'build.gradle.kts'
assert gradle.is_file(), f'Missing {gradle}'
src = gradle.read_text(encoding='utf-8')
assert 'applicationId = "com.novacut.editor"' in src
src = src.replace('applicationId = "com.novacut.editor"', 'applicationId = "com.solycut.videoeditor"', 1)
assert 'buildConfigField("boolean", "UPDATE_CHECK_AVAILABLE", "true")' in src
src = src.replace('buildConfigField("boolean", "UPDATE_CHECK_AVAILABLE", "true")', 'buildConfigField("boolean", "UPDATE_CHECK_AVAILABLE", "false")', 1)
# Keep all native libraries/features, compress .so files inside the APK.
# Android extracts native libs at install instead of loading them directly from the archive.
anchor = "    signingConfigs {"
assert anchor in src
src = src.replace(anchor, "    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }\n\n" + anchor, 1)
# Match upstream release's R8/shrinker settings on this independently signed debug build.
old_debug = "        debug {\n            isPseudoLocalesEnabled = true\n        }"
new_debug = """        debug {
            isPseudoLocalesEnabled = true
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }"""
assert old_debug in src
src = src.replace(old_debug, new_debug, 1)
gradle.write_text(src, encoding='utf-8')
resources = list((root / 'app' / 'src' / 'main' / 'res').glob('values*/strings.xml'))
assert resources
count = 0
for file in resources:
    text = file.read_text(encoding='utf-8')
    new_text, n = re.subn(r'(<string\s+name="app_name">)(.*?)(</string>)', lambda m: m.group(1) + 'Soly Cut' + m.group(3), text, count=1)
    if n:
        file.write_text(new_text, encoding='utf-8')
        count += 1
assert count
print(f'OK: applicationId, independent updater, and {count} localized app labels')
