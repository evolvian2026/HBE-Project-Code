package edu.example.notes;

/** A note, as stored and as sent to the browser. */
public record Note(long id, String title, boolean done) {}
