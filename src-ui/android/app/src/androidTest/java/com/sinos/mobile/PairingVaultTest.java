package com.sinos.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PairingVaultTest {
    @Test public void roundTripSurvivesInstanceRecreationWithoutPlaintextPreferences() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PairingVault vault = new PairingVault(context);
        try {
            vault.check(); vault.write("private-pairing-content-key");
            String stored = context.getSharedPreferences("pairing-vault", Context.MODE_PRIVATE).getString("device", "");
            assertFalse(stored.contains("private-pairing-content-key"));
            assertEquals("private-pairing-content-key", new PairingVault(context).read());
            vault.clear(); assertNull(new PairingVault(context).read());
        } finally { vault.clear(); }
    }
    @Test public void modifiedCiphertextIsRejected() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PairingVault vault = new PairingVault(context);
        try {
            vault.write("secret");
            context.getSharedPreferences("pairing-vault", Context.MODE_PRIVATE).edit().putString("device", "AAAA.AAAA").commit();
            assertThrows(Exception.class, vault::read);
        } finally { vault.clear(); }
    }
}
