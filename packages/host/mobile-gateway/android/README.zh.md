# DSH Mobile — Android 客户端（WebView 壳）

[English](README.md) | 中文

Android 端的"App"：一个极简 WebView 壳（Kotlin，**零第三方依赖**），配合
[dsh-mobile-gateway](../) 插件使用。手机用户装好 APK 后，App 会用保存的
用户名 + 访问令牌自动登录网关，然后全屏加载 DSH Web GUI。

## 功能

- 首次启动进入设置页：网关地址、用户名（可选）、访问令牌、"信任自签名证书"开关。
- 令牌用 **Android Keystore（AES/GCM）** 加密存储，不落明文 SharedPreferences。
- 自动 POST `/__mobile/login`，会话 cookie 写入 WebView 的 Cookie 管理器，再加载 UI。
- 浏览中遇到 401/403（令牌被轮换/移除）→ 跳回设置页重新输入。
- 菜单"切换账号"：清 cookie + 清凭据，回到设置页。
- 返回键走 WebView 历史；同网关地址在 App 内打开，外部链接交给系统浏览器。

## 构建（需要 Android SDK）

1. 用 Android Studio 打开本目录（`android/`），或命令行：

   ```sh
   # Requires Android SDK 34 (set ANDROID_HOME)
   cd android
   ./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
   # Output: app/build/outputs/apk/debug/app-debug.apk
   ```

2. 把 APK 装到目标手机（`adb install app-debug.apk`，或直接拷贝安装）。
3. 打开 App 填网关地址（`http://<电脑IP>:4080`）与管理员发放的令牌。

## 说明

- 工程配置：`compileSdk 34 / targetSdk 34 / minSdk 24 / Kotlin 1.9.24 / AGP 8.5.2`。
- `usesCleartextTraffic="true"`：局域网明文 HTTP 网关需要；若网关启用 HTTPS 可去掉。
- 信任自签名证书需在设置页显式勾选（默认拒绝，防止中间人）。
- 图标在 `app/src/main/res/mipmap-*/`（由脚本生成）。
