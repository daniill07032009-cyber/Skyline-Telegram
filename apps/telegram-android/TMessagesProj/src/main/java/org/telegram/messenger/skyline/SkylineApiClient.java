package org.telegram.messenger.skyline;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URLEncoder;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Small REST adapter for Skyline's Python API.
 *
 * The API base URL is injected by the caller; this class deliberately does not
 * fall back to Telegram endpoints or a hard-coded production host. Calls run on
 * a worker thread. Implementations of Callback must marshal UI updates to the
 * Android main thread themselves.
 *
 * This is an integration foundation, not yet wired into Telegram's native
 * login/chat screens. No bearer token or password is logged or persisted here.
 */
public final class SkylineApiClient implements AutoCloseable {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

    public interface Callback {
        void onSuccess(JSONObject body);
        void onError(int statusCode, String message);
    }

    private final String baseUrl;
    private final ExecutorService executor;

    public SkylineApiClient(String apiBaseUrl) {
        if (apiBaseUrl == null || apiBaseUrl.trim().isEmpty()) {
            throw new IllegalArgumentException("Skyline API base URL is required");
        }
        String normalized = apiBaseUrl.trim().replaceAll("/+$", "");
        if (!normalized.startsWith("https://")) {
            throw new IllegalArgumentException("Skyline API must use HTTPS");
        }
        this.baseUrl = normalized;
        this.executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "skyline-api");
            thread.setDaemon(true);
            return thread;
        });
    }

    public void register(
            String username,
            String email,
            String password,
            String verificationToken,
            Callback callback
    ) {
        if (callback == null) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("username", requireText(username, "username"));
            payload.put("email", requireText(email, "email"));
            payload.put("password", requireText(password, "password"));
            if (verificationToken != null && !verificationToken.trim().isEmpty()) {
                payload.put("verificationToken", verificationToken.trim());
            }
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(0, exception.getMessage());
            return;
        }
        execute("POST", "/auth/register", payload, null, callback);
    }

    /** Login with either username or email, matching Skyline's current API contract. */
    public void login(String identifier, String password, Callback callback) {
        if (callback == null) return;
        JSONObject payload = new JSONObject();
        String cleanIdentifier;
        try {
            cleanIdentifier = requireText(identifier, "username or email").trim();
            payload.put("password", requireText(password, "password"));
            if (cleanIdentifier.contains("@")) {
                payload.put("email", cleanIdentifier);
            } else {
                payload.put("username", cleanIdentifier);
            }
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(0, exception.getMessage());
            return;
        }
        execute("POST", "/auth/login", payload, null, callback);
    }

    public void getCurrentUser(String bearerToken, Callback callback) {
        if (callback == null) return;
        if (bearerToken == null || bearerToken.trim().isEmpty()) {
            callback.onError(0, "Skyline session token is required");
            return;
        }
        execute("GET", "/auth/me", null, bearerToken.trim(), callback);
    }

    /** Returns the user's direct-chat list. Array responses are exposed as body.items. */
    public void getContacts(String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        execute("GET", "/contacts", null, requireToken(bearerToken), callback);
    }

    /** Partial username/display-name search; the backend applies its own result limit. */
    public void searchUsers(String query, String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        try {
            String encoded = URLEncoder.encode(query == null ? "" : query.trim(), "UTF-8");
            execute("GET", "/users/search?q=" + encoded, null, requireToken(bearerToken), callback);
        } catch (Exception exception) {
            callback.onError(0, "Could not encode user search");
        }
    }

    /** Fetches a direct conversation. The server returns encrypted message envelopes. */
    public void getDirectMessages(String peerUserId, int limit, String beforeId, String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        try {
            String peer = requireText(peerUserId, "peer user id");
            int safeLimit = Math.max(1, Math.min(limit, 100));
            String path = "/messages/" + URLEncoder.encode(peer, "UTF-8") + "?limit=" + safeLimit;
            if (beforeId != null && !beforeId.trim().isEmpty()) {
                path += "&before=" + URLEncoder.encode(beforeId.trim(), "UTF-8");
            }
            execute("GET", path, null, requireToken(bearerToken), callback);
        } catch (Exception exception) {
            callback.onError(0, exception.getMessage() == null ? "Invalid conversation request" : exception.getMessage());
        }
    }

    /**
     * Sends an already-encrypted Skyline v4 envelope. Plaintext must never be passed
     * to this method; the server rejects unencrypted direct-message payloads.
     */
    public void sendEncryptedDirectMessage(String receiverId, String encryptedEnvelope, String replyTo,
                                           String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("receiverId", requireText(receiverId, "receiver id"));
            payload.put("type", "text");
            payload.put("text", requireText(encryptedEnvelope, "encrypted envelope"));
            if (replyTo != null && !replyTo.trim().isEmpty()) {
                payload.put("replyTo", replyTo.trim());
            }
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(0, exception.getMessage());
            return;
        }
        execute("POST", "/messages", payload, requireToken(bearerToken), callback);
    }

    /** Lists groups for the current Skyline account. */
    public void getGroups(String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        execute("GET", "/groups", null, requireToken(bearerToken), callback);
    }

    public void createGroup(String title, String description, JSONArray memberIds,
                            String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("title", requireText(title, "group title"));
            payload.put("description", description == null ? "" : description.trim());
            payload.put("memberIds", memberIds == null ? new JSONArray() : memberIds);
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(0, exception.getMessage());
            return;
        }
        execute("POST", "/groups", payload, requireToken(bearerToken), callback);
    }

    public void getGroupMessages(String groupId, int limit, String beforeId,
                                 String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        try {
            String group = requireText(groupId, "group id");
            int safeLimit = Math.max(1, Math.min(limit, 100));
            String path = "/groups/" + URLEncoder.encode(group, "UTF-8") + "/messages?limit=" + safeLimit;
            if (beforeId != null && !beforeId.trim().isEmpty()) {
                path += "&before=" + URLEncoder.encode(beforeId.trim(), "UTF-8");
            }
            execute("GET", path, null, requireToken(bearerToken), callback);
        } catch (Exception exception) {
            callback.onError(0, exception.getMessage() == null ? "Invalid group request" : exception.getMessage());
        }
    }

    /** Sends an already-encrypted envelope to a Skyline group. */
    public void sendEncryptedGroupMessage(String groupId, String encryptedEnvelope,
                                          String bearerToken, Callback callback) {
        if (callback == null || !hasToken(bearerToken, callback)) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("text", requireText(encryptedEnvelope, "encrypted envelope"));
            payload.put("type", "text");
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(0, exception.getMessage());
            return;
        }
        try {
            String group = URLEncoder.encode(requireText(groupId, "group id"), "UTF-8");
            execute("POST", "/groups/" + group + "/messages", payload, requireToken(bearerToken), callback);
        } catch (Exception exception) {
            callback.onError(0, exception.getMessage() == null ? "Invalid group request" : exception.getMessage());
        }
    }

    private boolean hasToken(String bearerToken, Callback callback) {
        if (callback == null) return false;
        if (bearerToken == null || bearerToken.trim().isEmpty()) {
            callback.onError(0, "Skyline session token is required");
            return false;
        }
        return true;
    }

    private String requireToken(String bearerToken) {
        if (bearerToken == null || bearerToken.trim().isEmpty()) {
            throw new IllegalArgumentException("Skyline session token is required");
        }
        return bearerToken.trim();
    }

    private void execute(
            String method,
            String path,
            JSONObject payload,
            String bearerToken,
            Callback callback
    ) {
        if (callback == null) return;
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(baseUrl + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "application/json");
                if (payload != null) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                }
                if (bearerToken != null) {
                    connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
                }

                if (payload != null) {
                    byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(bytes);
                    }
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300
                        ? connection.getInputStream()
                        : connection.getErrorStream();
                String response = readBounded(stream);
                JSONObject body;
                try {
                    if (response.isEmpty()) {
                        body = new JSONObject();
                    } else if (response.trim().startsWith("[")) {
                        body = new JSONObject().put("items", new JSONArray(response));
                    } else {
                        body = new JSONObject(response);
                    }
                } catch (JSONException invalidJson) {
                    callback.onError(status, "Skyline API returned an invalid response");
                    return;
                }

                if (status >= 200 && status < 300) {
                    callback.onSuccess(body);
                } else {
                    String message = body.optString("detail", body.optString("error", "Skyline API request failed"));
                    callback.onError(status, message);
                }
            } catch (IOException exception) {
                // Avoid exposing request credentials, URLs with query strings, or raw response data.
                callback.onError(0, "Could not connect to the Skyline server");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static String readBounded(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream;
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder result = new StringBuilder();
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                if (result.length() + count > MAX_RESPONSE_BYTES) {
                    throw new IOException("Skyline API response exceeded the size limit");
                }
                result.append(buffer, 0, count);
            }
            return result.toString();
        }
    }

    private static String requireText(String value, String field) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(field + " is required");
        }
        return value.trim();
    }

    @Override
    public void close() {
        executor.shutdownNow();
    }
}
