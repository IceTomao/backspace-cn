package me.kevz.backspace

import org.junit.Assert.*
import org.junit.Test

class ClientPolicyTest {
    @Test fun serverOriginsAreStrict() {
        assertEquals(ClientPolicy.DEFAULT_SERVER, ClientPolicy.server("chat.kevz.me:2096/"))
        for (invalid in listOf("http://chat.kevz.me", "https://u:p@chat.kevz.me", "https://chat.kevz.me/api",
            "https://chat.kevz.me?q=a", "https://chat.kevz.me#x", "https://chat.kevz.me:99999")) {
            assertTrue(invalid, runCatching { ClientPolicy.server(invalid) }.isFailure)
        }
    }
    @Test fun noUnrequestedBackgroundConnection() {
        assertFalse(ClientPolicy.shouldConnect(false, false, false))
        assertTrue(ClientPolicy.shouldConnect(true, false, false))
        assertTrue(ClientPolicy.shouldConnect(false, true, false))
        assertTrue(ClientPolicy.shouldConnect(false, false, true))
    }
    @Test fun onlyBundledMainPageCanUseBridge() {
        assertTrue(ClientPolicy.bundledPage("https://localhost/channels/@me"))
        for (invalid in listOf("https://chat.kevz.me", "http://localhost", "https://localhost.evil.test",
            "file:///localhost/index.html", "https://u@localhost", "https://localhost:1234")) {
            assertFalse(invalid, ClientPolicy.bundledPage(invalid))
        }
    }
    @Test fun defaultThemeAndPermissionDenial() {
        assertEquals("system", ClientPolicy.theme(""))
        assertEquals("system", ClientPolicy.theme("invalid"))
        assertEquals("light", ClientPolicy.theme("light"))
        assertFalse(ClientPolicy.microphoneAllowed(true, false))
        assertFalse(ClientPolicy.microphoneAllowed(false, true))
        assertTrue(ClientPolicy.microphoneAllowed(true, true))
    }
    @Test fun notificationRules() {
        assertFalse(ClientPolicy.shouldNotify("me", "me", true, "", true, false))
        assertFalse(ClientPolicy.shouldNotify("me", "other", true, "", true, true))
        assertFalse(ClientPolicy.shouldNotify("me", "other", false, "", false, false))
        assertTrue(ClientPolicy.shouldNotify("me", "other", false, "<@me>", false, false))
        assertTrue(ClientPolicy.shouldNotify("me", "other", true, "", false, false))
    }
}
