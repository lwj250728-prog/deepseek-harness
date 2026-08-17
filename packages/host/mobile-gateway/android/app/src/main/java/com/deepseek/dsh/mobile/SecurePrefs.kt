package com.deepseek.dsh.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Token storage: AES/GCM via the Android Keystore, so the access token never
 * sits in plain SharedPreferences. Zero third-party dependencies.
 */
object SecurePrefs {

    private const val KEY_ALIAS = "dsh_mobile_gateway_token"
    private const val PREFS = "dsh_mobile"
    private const val CIPHER_ALIAS = "cipher_token"

    private fun keyStore(): KeyStore {
        val ks = KeyStore.getInstance("AndroidKeyStore")
        ks.load(null)
        return ks
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = keyStore()
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    fun saveToken(context: Context, token: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val iv = cipher.iv
            val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            val blob = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
                    Base64.encodeToString(encrypted, Base64.NO_WRAP)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(CIPHER_ALIAS, blob).apply()
        } catch (_: Exception) {
            // Keystore failure (rare): fall back to plain storage rather than
            // bricking the app, but never log the token.
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString("token_plain_fallback", token).apply()
        }
    }

    fun loadToken(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val blob = prefs.getString(CIPHER_ALIAS, null)
        if (blob != null) {
            try {
                val parts = blob.split(":")
                if (parts.size == 2) {
                    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                    val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
                    return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
                }
            } catch (_: Exception) {
                return null
            }
        }
        return prefs.getString("token_plain_fallback", null)
    }

    fun clearToken(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(CIPHER_ALIAS).remove("token_plain_fallback").apply()
    }
}
