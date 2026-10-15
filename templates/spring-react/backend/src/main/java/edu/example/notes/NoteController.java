package edu.example.notes;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** The example API: GET /health, and GET and POST /api/notes/. Replace it with yours. */
@RestController
public class NoteController {
  /** What POST /api/notes/ accepts. */
  public record NewNote(String title) {}

  private final JdbcClient db;

  public NoteController(JdbcClient db) {
    this.db = db;
  }

  @GetMapping("/health")
  public Map<String, String> health() {
    return Map.of("status", "ok");
  }

  @GetMapping({"/api/notes", "/api/notes/"})
  public List<Note> list() {
    return db.sql("select id, title, done from notes order by id").query(Note.class).list();
  }

  @PostMapping({"/api/notes", "/api/notes/"})
  public ResponseEntity<?> create(@RequestBody(required = false) NewNote body) {
    String title = body == null || body.title() == null ? "" : body.title().trim();
    if (title.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("error", "title is required"));
    }
    KeyHolder keys = new GeneratedKeyHolder();
    db.sql("insert into notes (title) values (?)").param(title).update(keys, "id");
    long id = keys.getKeyAs(Long.class);
    return ResponseEntity.status(HttpStatus.CREATED).body(new Note(id, title, false));
  }
}
