package edu.example.notes;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

/** The API, called over HTTP on a random port (with the in-memory database). */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NotesApiTests {
  @Value("${local.server.port}")
  int port;

  private final HttpClient http = HttpClient.newHttpClient();

  private HttpResponse<String> get(String path) throws Exception {
    return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private HttpResponse<String> post(String path, String json) throws Exception {
    HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(json))
        .build();
    return http.send(request, HttpResponse.BodyHandlers.ofString());
  }

  @Test
  void healthAnswers() throws Exception {
    assertEquals(200, get("/health").statusCode());
  }

  @Test
  void createsAndListsNotes() throws Exception {
    HttpResponse<String> created = post("/api/notes/", "{\"title\": \"Buy milk\"}");
    assertEquals(201, created.statusCode());
    assertTrue(created.body().contains("\"title\":\"Buy milk\""), created.body());
    assertTrue(get("/api/notes/").body().contains("Buy milk"));
  }

  @Test
  void titleIsRequired() throws Exception {
    assertEquals(400, post("/api/notes/", "{\"title\": \"  \"}").statusCode());
    assertEquals(400, post("/api/notes/", "{}").statusCode());
  }
}
