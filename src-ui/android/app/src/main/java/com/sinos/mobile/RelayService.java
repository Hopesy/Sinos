package com.sinos.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** A user-visible connected-device session, not a WebView timer keep-alive. */
public class RelayService extends Service {
    static final String CONNECT = "com.sinos.mobile.CONNECT", STOP = "com.sinos.mobile.STOP";
    private static final String CHANNEL = "sinos.connection";
    private static final int NOTIFICATION = 42;
    private static RelayService instance;
    private static JSObject terminalEvent;
    private static WeakReference<SinosMobilePlugin> plugin = new WeakReference<>(null);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS).retryOnConnectionFailure(true).build();
    private final ArrayDeque<JSObject> events = new ArrayDeque<>();
    private int bufferedBytes = 0, attempt = 0, generation = 0;
    private String id, url;
    private WebSocket socket;
    private boolean open, ended;
    private long lastSeen;
    private ConnectivityManager connectivity;
    private Network network;
    private final Runnable retry = this::openSocket;
    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            if (ended) return;
            if (open && SystemClock.elapsedRealtime() - lastSeen > 30000) restart();
            else if (open && socket != null) socket.send("ping");
            handler.postDelayed(this, 10000);
        }
    };
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(@NonNull Network available) { handler.post(() -> {
            if (network != null && !network.equals(available) && !ended) restart();
            network = available;
            if (!open && !ended) { handler.removeCallbacks(retry); openSocket(); }
        }); }
        @Override public void onLost(@NonNull Network lost) { handler.post(() -> {
            if (lost.equals(network)) { network = null; if (!ended) restart(); }
        }); }
    };
    static void attach(SinosMobilePlugin next) {
        new Handler(Looper.getMainLooper()).post(() -> {
            plugin = new WeakReference<>(next);
            if (instance != null) { instance.flush(); if (instance.open && SystemClock.elapsedRealtime() - instance.lastSeen > 30000) instance.restart(); }
            else if (terminalEvent != null && next.deliver(terminalEvent)) terminalEvent = null;
        });
    }
    static void detach(SinosMobilePlugin current) {
        if (plugin.get() == current) plugin.clear();
    }
    @Override public void onCreate() {
        super.onCreate(); instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "电脑连接", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持与已配对电脑的加密连接");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        connectivity = getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) { finish(4000, "paused"); return START_NOT_STICKY; }
        String nextId = intent.getStringExtra("id"), nextUrl = intent.getStringExtra("url");
        if (nextId == null || nextUrl == null) { stopSelf(); return START_NOT_STICKY; }
        Notification notification = notification("正在连接你的电脑…");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(NOTIFICATION, notification);
        if (!nextId.equals(id)) {
            generation++; if (socket != null) socket.cancel(); handler.removeCallbacks(retry);
            events.clear(); terminalEvent = null; bufferedBytes = 0; id = nextId; url = nextUrl; ended = false; attempt = 0; open = false;
            openSocket(); handler.removeCallbacks(heartbeat); handler.postDelayed(heartbeat, 10000);
        }
        return START_NOT_STICKY;
    }
    private Notification notification(String text) {
        PendingIntent launch = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RelayService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_connection)
            .setContentTitle("Sinos · 电脑连接").setContentText(text).setContentIntent(launch)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .addAction(0, "暂停连接", stop).build();
    }
    private void status(String text) { getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text)); }
    private JSObject event(String type) { JSObject event = new JSObject(); event.put("id", id); event.put("type", type); return event; }
    private void emit(JSObject event) {
        flush();
        SinosMobilePlugin target = plugin.get();
        if (target != null && events.isEmpty() && target.deliver(event)) return;
        int size = event.toString().length() * 2;
        // A paused WebView may not consume RPC replies. Bound memory and resync
        // instead of retaining unlimited ciphertext or replaying partial chunks.
        if (bufferedBytes + size > 4 * 1024 * 1024 || events.size() >= 128) {
            events.clear(); bufferedBytes = 0; handler.post(this::restart); return;
        }
        events.add(event); bufferedBytes += size;
    }
    private void flush() {
        SinosMobilePlugin target = plugin.get();
        while (target != null && !events.isEmpty()) {
            JSObject event = events.peek();
            if (!target.deliver(event)) break;
            events.remove(); bufferedBytes -= event.toString().length() * 2;
        }
    }
    private void openSocket() {
        if (ended || url == null) return;
        handler.removeCallbacks(retry);
        final int epoch = ++generation;
        if (socket != null) socket.cancel(); open = false;
        socket = http.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            @Override public void onOpen(@NonNull WebSocket ws, @NonNull Response response) { handler.post(() -> {
                if (epoch != generation || ended) { ws.cancel(); return; }
                open = true; attempt = 0; lastSeen = SystemClock.elapsedRealtime(); status("已连接中继 · 加密通道待命"); emit(event("open"));
            }); }
            @Override public void onMessage(@NonNull WebSocket ws, @NonNull String text) { handler.post(() -> {
                if (epoch != generation || ended) return;
                lastSeen = SystemClock.elapsedRealtime(); if ("pong".equals(text)) return;
                if (text.length() > 8192) return;
                JSObject data = event("text"); data.put("data", text); emit(data);
                try {
                    String type = new JSObject(text).getString("type");
                    if ("revoked".equals(type)) finish(1008, "revoked");
                    else if ("host-offline".equals(type) || "peer-left".equals(type)) status("电脑离线 · 等待电脑重新上线");
                    else if ("peer-joined".equals(type)) status("电脑已上线 · 加密连接中");
                } catch (Exception ignored) { }
            }); }
            @Override public void onMessage(@NonNull WebSocket ws, @NonNull ByteString bytes) { handler.post(() -> {
                if (epoch != generation || ended) return;
                lastSeen = SystemClock.elapsedRealtime(); if (bytes.size() > 1048576) return;
                JSObject data = event("binary"); data.put("data", bytes.base64()); emit(data);
            }); }
            @Override public void onClosing(@NonNull WebSocket ws, int code, @NonNull String reason) { ws.close(code, reason); }
            @Override public void onClosed(@NonNull WebSocket ws, int code, @NonNull String reason) { handler.post(() -> {
                if (epoch != generation || ended) return;
                if (code == 1008 || (code == 1000 && "replaced".equals(reason))) finish(code, reason);
                else disconnected(code, reason);
            }); }
            @Override public void onFailure(@NonNull WebSocket ws, @NonNull Throwable failure, Response response) { handler.post(() -> {
                if (epoch != generation || ended) return;
                if (response != null && (response.code() == 401 || response.code() == 403 || response.code() == 404)) finish(1008, "revoked");
                else disconnected(1006, "network-unavailable");
            }); }
        });
    }
    private void disconnected(int code, String reason) {
        open = false;
        JSObject event = event("close"); event.put("code", code); event.put("reason", reason); event.put("retrying", true); emit(event);
        status("连接中断 · 正在自动重连");
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, Math.min(30000, 1000L << Math.min(attempt++, 5)));
    }
    private void restart() {
        if (ended || url == null) return;
        generation++; if (socket != null) socket.cancel(); disconnected(1006, "reconnecting");
    }
    static boolean send(String id, String data, boolean binary) {
        RelayService service = instance;
        if (service == null || service.ended || !service.open || id == null || !id.equals(service.id) || data == null || data.length() > 1400000) return false;
        try {
            boolean sent = binary ? service.socket.send(ByteString.of(Base64.decode(data, Base64.NO_WRAP))) : service.socket.send(data);
            if (!sent) service.restart(); return sent;
        } catch (Exception ignored) { return false; }
    }
    static void disconnect(String id) { if (instance != null && id != null && id.equals(instance.id)) instance.finish(1000, "closed"); }
    static void forgetPairing() { if (instance != null) instance.finish(1000, "forgotten"); terminalEvent = null; }
    private void finish(int code, String reason) {
        if (!ended) {
            ended = true; open = false; generation++;
            if (socket != null) socket.cancel();
            JSObject event = event("close"); event.put("code", code); event.put("reason", reason); event.put("retrying", false); terminalEvent = event; emit(event);
        }
        handler.removeCallbacks(retry); handler.removeCallbacks(heartbeat);
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onDestroy() {
        if (!ended) finish(1011, "service-stopped");
        handler.removeCallbacksAndMessages(null);
        try { connectivity.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { }
        http.dispatcher().executorService().shutdown(); http.connectionPool().evictAll();
        if (instance == this) instance = null;
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
