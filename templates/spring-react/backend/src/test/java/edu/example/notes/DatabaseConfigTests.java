package edu.example.notes;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;

/** DATABASE_URL becomes a PostgreSQL connection; without it, an in-memory database. */
class DatabaseConfigTests {
  private final DatabaseConfig config = new DatabaseConfig();

  @Test
  void readsDatabaseUrl() {
    try (HikariDataSource ds = (HikariDataSource) config.dataSource("postgres://app:p%40ss@db:5433/notes")) {
      assertEquals("jdbc:postgresql://db:5433/notes", ds.getJdbcUrl());
      assertEquals("app", ds.getUsername());
      assertEquals("p@ss", ds.getPassword());
    }
  }

  @Test
  void usesInMemoryDatabaseWithoutOne() {
    try (HikariDataSource ds = (HikariDataSource) config.dataSource("")) {
      assertEquals("jdbc:h2:mem:notes;DB_CLOSE_DELAY=-1", ds.getJdbcUrl());
    }
  }
}
