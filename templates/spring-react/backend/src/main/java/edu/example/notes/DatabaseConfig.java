package edu.example.notes;

import com.zaxxer.hikari.HikariDataSource;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * PostgreSQL from DATABASE_URL (postgres://user:password@host:port/database), which the grader
 * sets; an in-memory H2 database without it (your tests, and running without Docker).
 */
@Configuration
public class DatabaseConfig {
  @Bean
  public DataSource dataSource(@Value("${DATABASE_URL:}") String databaseUrl) {
    HikariDataSource ds = new HikariDataSource();
    if (databaseUrl.isBlank()) {
      ds.setJdbcUrl("jdbc:h2:mem:notes;DB_CLOSE_DELAY=-1");
      return ds;
    }
    URI uri = URI.create(databaseUrl);
    String[] user = uri.getUserInfo().split(":", 2);
    int port = uri.getPort() == -1 ? 5432 : uri.getPort();
    ds.setJdbcUrl("jdbc:postgresql://" + uri.getHost() + ":" + port + uri.getPath());
    ds.setUsername(decode(user[0]));
    ds.setPassword(user.length > 1 ? decode(user[1]) : "");
    // The database may still be starting: keep trying for a minute.
    ds.setInitializationFailTimeout(60_000);
    return ds;
  }

  private static String decode(String s) {
    return URLDecoder.decode(s, StandardCharsets.UTF_8);
  }
}
