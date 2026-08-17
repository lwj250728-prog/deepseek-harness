package com.deepseek.dsh.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The DSH Mobile shell: a WebView pointed at the authenticated gateway. On
 * launch it POSTs the stored user+token to /__mobile/login (the cookie lands
 * in the shared cookie jar), then loads the DSH Web UI. Any 401/403 while
 * browsing bounces back to setup so the owner can re-enter a fresh token.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private var trustSelfSigned = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        progress = findViewById(R.id.progress)
        webView = findViewById(R.id.webview)

        val prefs = getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE)
        val baseUrl = prefs.getString("base_url", "") ?: ""
        trustSelfSigned = prefs.getBoolean("trust_self_signed", false)

        if (baseUrl.isBlank()) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        configureWebView()
        loginAndLoad(baseUrl)
    }

    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        CookieManager.getInstance().setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
            override fun onReceivedTitle(view: WebView?, title: String?) {
                // keep the launcher title stable
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val host = url.host
                val baseHost = Uri.parse(getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE)
                    .getString("base_url", "") ?: "").host
                return if (host != null && host == baseHost) {
                    false // same gateway: load in-app
                } else {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (_: Exception) { /* no browser */ }
                    true
                }
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                val uri = Uri.parse(url ?: return false)
                val host = uri.host
                val baseHost = Uri.parse(getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE)
                    .getString("base_url", "") ?: "").host
                return if (host != null && host == baseHost) false
                else {
                    try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) {}
                    true
                }
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) {
                if (trustSelfSigned) handler?.proceed()
                else {
                    handler?.cancel()
                    Toast.makeText(this@MainActivity, "证书不受信任（可在设置中勾选信任自签名）", Toast.LENGTH_LONG).show()
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Toast.makeText(this@MainActivity, "无法连接网关：${error?.description}", Toast.LENGTH_LONG).show()
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progress.visibility = View.GONE
            }
        }
    }

    /** POST the stored credentials to the gateway login endpoint, then load the UI. */
    private fun loginAndLoad(baseUrl: String) {
        val token = SecurePrefs.loadToken(this)
        val user = getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE).getString("user_name", "") ?: ""
        if (token.isNullOrBlank()) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        Thread {
            var failed = false
            try {
                val loginUrl = URL("$baseUrl/__mobile/login")
                val connection = loginUrl.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                val body = StringBuilder()
                if (user.isNotBlank()) {
                    body.append("user=").append(URLEncoder.encode(user, "UTF-8")).append('&')
                }
                body.append("token=").append(URLEncoder.encode(token, "UTF-8"))
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                if (status == 302 || status == 200) {
                    connection.headerFields["Set-Cookie"]?.forEach { cookie ->
                        // Hand the session cookie to the WebView's jar before it loads.
                        val parts = cookie.split(";")
                        val nameValue = parts.firstOrNull()?.trim().orEmpty()
                        if (nameValue.startsWith("dsh_mgw_session=")) {
                            val domain = Uri.parse(baseUrl).host ?: ""
                            CookieManager.getInstance().setCookie("$baseUrl/", nameValue)
                            CookieManager.getInstance().setCookie("http://$domain/", nameValue)
                        }
                    }
                } else {
                    failed = true
                }
                connection.disconnect()
            } catch (_: Exception) {
                failed = true
            }
            runOnUiThread {
                if (failed) {
                    Toast.makeText(this, "登录失败：请检查网关地址与访问令牌", Toast.LENGTH_LONG).show()
                    startActivity(Intent(this, SetupActivity::class.java))
                    finish()
                } else {
                    webView.loadUrl(baseUrl)
                }
            }
        }.start()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onCreateOptionsMenu(menu: android.view.Menu?): Boolean {
        menu?.add(0, 1, 0, getString(R.string.switch_account))
        return true
    }

    override fun onOptionsItemSelected(item: android.view.MenuItem): Boolean {
        if (item.itemId == 1) {
            switchAccount(this)
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        /** Called from the overflow menu: drop cookies + credentials and reconfigure. */
        fun switchAccount(activity: Activity) {
            CookieManager.getInstance().removeAllCookies(null)
            SecurePrefs.clearToken(activity)
            activity.getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE)
                .edit().remove("user_name").apply()
            activity.startActivity(Intent(activity, SetupActivity::class.java))
            activity.finish()
        }
    }
}
