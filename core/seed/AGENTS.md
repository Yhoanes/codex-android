# Codex Android Agent Rules & Environment Guidelines

- **Platform:** Native Android (`aarch64` / ARM64, Linux kernel 6.1+, zero PRoot).
- **App Sandbox (`$HOME`):** `/data/user/0/com.ce.ide/files`
- **Bionic Userspace (`$PREFIX`):** `/data/user/0/com.ce.ide/files/usr` (`$PREFIX/bin` is on `$PATH`)
- **Runtime Binaries:** `/data/user/0/com.ce.ide/files/runtime/bin` (`codex`, `node`, `rg`, `rish`, `xdg-open`)
- **Shared Storage:** `/storage/emulated/0` (Default project folder: `/storage/emulated/0/Documents/Codex`)
- **Package Manager:** `pkg update && pkg install git python nodejs clang rust` (do not pass `-y`; run `ce-fix-paths` after global `pip`/`npm` installs).
- **Elevated ADB Shell (`rish`):** Run `rish -c "<cmd>"` when Shizuku (`uid=2000`) permissions are needed (`pm install`, `logcat`, `am start`).
- **Opening Links:** Run `xdg-open "https://..."` to open URLs in the Android browser.
