package com.sinos.mobile;

import com.journeyapps.barcodescanner.CaptureActivity;
import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

// Use the phone's current orientation instead of CaptureActivity's landscape default.
public class SinosScanActivity extends CaptureActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
