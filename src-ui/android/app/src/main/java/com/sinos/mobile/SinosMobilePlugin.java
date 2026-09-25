package com.sinos.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanOptions;
import com.journeyapps.barcodescanner.ScanIntentResult;
import java.net.URI;

@CapacitorPlugin(name = "SinosMobile", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class SinosMobilePlugin extends Plugin {
    private volatile boolean active = true;
    private PairingVault vault() { return new PairingVault(getContext()); }
    @Override public void load() { RelayService.attach(this); }
    @Override protected void handleOnResume() { active = true; RelayService.attach(this); }
    @Override protected void handleOnPause() { active = false; }
    @Override protected void handleOnDestroy() { RelayService.detach(this); }
    boolean deliver(JSObject event) {
        if (!active || !hasListeners("socket")) return false;
        notifyListeners("socket", event); return true;
    }
    @PluginMethod public void readPairing(PluginCall call) {
        try { JSObject result = new JSObject(); result.put("value", vault().read()); call.resolve(result); }
        catch (Exception ignored) { call.reject("无法读取安全配对记录"); }
    }
    @PluginMethod public void writePairing(PluginCall call) {
        try { String value = call.getString("value"); if (value == null) throw new Exception(); vault().write(value); call.resolve(); }
        catch (Exception ignored) { call.reject("无法保存配对记录"); }
    }
    @PluginMethod public void checkStorage(PluginCall call) {
        try { vault().check(); call.resolve(); } catch (Exception ignored) { call.reject("安全存储不可用"); }
    }
    @PluginMethod public void clearPairing(PluginCall call) {
        try {
            vault().clear();
            getActivity().runOnUiThread(() -> { RelayService.forgetPairing(); call.resolve(); });
        } catch (Exception ignored) { call.reject("无法清除配对记录"); }
    }
    @PluginMethod public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED)
            requestPermissionForAlias("notifications", call, "notificationsDone");
        else call.resolve();
    }
    @PluginMethod public void clipboardRead(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
            ClipData data = clipboard.getPrimaryClip();
            CharSequence text = data != null && data.getItemCount() > 0 ? data.getItemAt(0).coerceToText(getContext()) : "";
            JSObject result = new JSObject(); result.put("value", text == null ? "" : text.toString()); call.resolve(result);
        });
    }
    @PluginMethod public void clipboardWrite(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getContext().getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Sinos", call.getString("value", "")));
            call.resolve();
        });
    }
    @PermissionCallback private void notificationsDone(PluginCall call) { call.resolve(); }
    @PluginMethod public void scan(PluginCall call) {
        ScanOptions options = new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("扫描电脑上 Sinos 的配对二维码").setBeepEnabled(false).setOrientationLocked(false)
            .setCaptureActivity(SinosScanActivity.class);
        startActivityForResult(call, options.createScanIntent(getContext()), "scanDone");
    }
    @ActivityCallback private void scanDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ScanIntentResult scan = ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData());
        JSObject value = new JSObject(); value.put("value", scan.getContents()); call.resolve(value);
    }
    @PluginMethod public void connect(PluginCall call) {
        String id = call.getString("id"), url = call.getString("url");
        try {
            URI uri = new URI(url == null ? "" : url);
            if (id == null || id.length() > 64 || !"wss".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                !uri.getPath().matches("/v1/pair/[\\w-]{22}") || uri.getFragment() != null) throw new Exception();
        } catch (Exception ignored) { call.reject("Invalid relay connection"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(getContext(), RelayService.class).setAction(RelayService.CONNECT)
                    .putExtra("id", id).putExtra("url", url);
                ContextCompat.startForegroundService(getContext(), intent);
                call.resolve();
            } catch (Exception ignored) { call.reject("无法启动连接服务，请在前台打开 App 后重试"); }
        });
    }
    @PluginMethod public void send(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (RelayService.send(call.getString("id"), call.getString("data"), Boolean.TRUE.equals(call.getBoolean("binary")))) call.resolve();
            else call.reject("Connection unavailable");
        });
    }
    @PluginMethod public void disconnect(PluginCall call) {
        getActivity().runOnUiThread(() -> { RelayService.disconnect(call.getString("id")); call.resolve(); });
    }
}
