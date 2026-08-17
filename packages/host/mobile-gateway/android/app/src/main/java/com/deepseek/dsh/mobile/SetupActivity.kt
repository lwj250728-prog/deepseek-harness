package com.deepseek.dsh.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast

/**
 * One-time (or re)configuration: gateway address, optional user name, and the
 * access token issued by the gateway admin. Credentials are stored with the
 * token encrypted via Android Keystore; then MainActivity takes over.
 */
class SetupActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val baseUrl = findViewById<EditText>(R.id.input_base_url)
        val user = findViewById<EditText>(R.id.input_user)
        val token = findViewById<EditText>(R.id.input_token)
        val trustSsl = findViewById<CheckBox>(R.id.input_trust_ssl)
        val save = findViewById<Button>(R.id.btn_save)

        val prefs = getSharedPreferences("dsh_mobile", Context.MODE_PRIVATE)
        baseUrl.setText(prefs.getString("base_url", "http://192.168.1.10:4080"))
        user.setText(prefs.getString("user_name", ""))

        save.setOnClickListener {
            val url = baseUrl.text.toString().trim().trimEnd('/')
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                Toast.makeText(this, "网关地址需以 http:// 或 https:// 开头", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            val tokenText = token.text.toString().trim()
            if (tokenText.isEmpty()) {
                Toast.makeText(this, "请输入访问令牌", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            prefs.edit()
                .putString("base_url", url)
                .putString("user_name", user.text.toString().trim())
                .putBoolean("trust_self_signed", trustSsl.isChecked)
                .apply()
            SecurePrefs.saveToken(this, tokenText)
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }
}
