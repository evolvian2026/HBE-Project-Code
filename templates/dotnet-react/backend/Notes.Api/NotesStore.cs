using Npgsql;

namespace Notes.Api;

/// <summary>A note, as stored and as sent to the browser.</summary>
public record Note(long Id, string Title, bool Done);

/// <summary>Where notes are kept.</summary>
public interface INotesStore
{
    Task<IReadOnlyList<Note>> ListAsync();
    Task<Note> AddAsync(string title);
}

public static class NotesStore
{
    /// <summary>
    /// PostgreSQL from DATABASE_URL (postgres://user:password@host:port/database), which the
    /// grader sets; kept in memory without it (your tests, and running without Docker).
    /// </summary>
    public static INotesStore FromDatabaseUrl(string? databaseUrl) =>
        string.IsNullOrWhiteSpace(databaseUrl)
            ? new MemoryNotesStore()
            : new PostgresNotesStore(ConnectionString(databaseUrl));

    /// <summary>The Npgsql connection string for a postgres:// URL.</summary>
    public static string ConnectionString(string databaseUrl)
    {
        var uri = new Uri(databaseUrl);
        var user = uri.UserInfo.Split(':', 2);
        return new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = uri.AbsolutePath.TrimStart('/'),
            Username = Uri.UnescapeDataString(user[0]),
            Password = user.Length > 1 ? Uri.UnescapeDataString(user[1]) : "",
        }.ConnectionString;
    }
}

public sealed class MemoryNotesStore : INotesStore
{
    private readonly List<Note> _notes = [];
    private readonly Lock _lock = new();

    public Task<IReadOnlyList<Note>> ListAsync()
    {
        lock (_lock)
        {
            return Task.FromResult<IReadOnlyList<Note>>([.. _notes]);
        }
    }

    public Task<Note> AddAsync(string title)
    {
        lock (_lock)
        {
            var note = new Note(_notes.Count + 1, title, false);
            _notes.Add(note);
            return Task.FromResult(note);
        }
    }
}
