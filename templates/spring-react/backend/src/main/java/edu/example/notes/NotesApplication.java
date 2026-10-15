package edu.example.notes;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** The app. Start here: the example notes API is in NoteController. */
@SpringBootApplication
public class NotesApplication {
  public static void main(String[] args) {
    SpringApplication.run(NotesApplication.class, args);
  }
}
