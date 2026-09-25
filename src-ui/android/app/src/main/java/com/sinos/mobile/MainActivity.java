package com.sinos.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SinosMobilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
