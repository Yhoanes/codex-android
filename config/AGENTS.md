# Codex for Android — Native ARM64 Environment Guidelines

- **Platform:** Native Android (`aarch64` / ARM64, Linux kernel 6.1+, zero PRoot).
- **App Sandbox (`$HOME`):** `/data/user/0/com.ce.ide/files`
- **Bionic Userspace (`$PREFIX`):** `/data/user/0/com.ce.ide/files/usr` (`$PREFIX/bin` is on `$PATH`)
- **Runtime Binaries:** `/data/user/0/com.ce.ide/files/runtime/bin` (`codex`, `node`, `rg`, `rish`, `xdg-open`)
- **Shared Storage:** `/storage/emulated/0` (Default workspace: `/storage/emulated/0/Documents/Codex`)
- **Package Manager:** `pkg update && pkg install <package>` (do not pass `-y`; run `ce-fix-paths` after global `npm`/`pip` installs).
- **Android Sandbox Rules:** Desktop Linux `bwrap` is not supported on unrooted Android kernels; commands execute natively in the Android app userspace. Use `rish -c "<cmd>"` when Shizuku (`uid=2000`) ADB shell access is needed, and `xdg-open "<url>"` to open links in the Android browser.
