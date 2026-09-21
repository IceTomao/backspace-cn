package me.kevz.backspace

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface ProfileVault {
    fun read(profile: String): JSONObject
    fun write(profile: String, value: JSONObject)
}
class SecureVault(context: Context) : ProfileVault {
    private val prefs = context.getSharedPreferences("secure-vault", Context.MODE_PRIVATE)
    private val key: SecretKey
        get() {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey("backspace-v1", null) as? SecretKey)?.let { return it }
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder("backspace-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }

    // A corrupt or inaccessible vault is an error, never silently reset to an
    // empty account. Android backups are disabled because the key is device-bound.
    override fun read(profile: String): JSONObject {
        val record = prefs.getString(profile, null) ?: return JSONObject()
        val bytes = Base64.decode(record, Base64.NO_WRAP)
        require(bytes.size > 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(profile.toByteArray(Charsets.UTF_8))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    override fun write(profile: String, value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(profile.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString(profile, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
            "Unable to save account settings"
        }
    }
}
