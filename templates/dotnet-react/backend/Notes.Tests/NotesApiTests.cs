using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Notes.Api;

namespace Notes.Tests;

/// <summary>The API, called over HTTP in memory (with the in-memory store).</summary>
public class NotesApiTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task HealthAnswers()
    {
        var res = await _client.GetAsync("/health", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task CreatesAndListsNotes()
    {
        var token = TestContext.Current.CancellationToken;
        var created = await _client.PostAsJsonAsync("/api/notes/", new { title = "Buy milk" }, token);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal("Buy milk", (await created.Content.ReadFromJsonAsync<Note>(token))!.Title);
        var notes = await _client.GetFromJsonAsync<Note[]>("/api/notes", token);
        Assert.Contains(notes!, n => n.Title == "Buy milk");
    }

    [Fact]
    public async Task TitleIsRequired()
    {
        var token = TestContext.Current.CancellationToken;
        var blank = await _client.PostAsJsonAsync("/api/notes/", new { title = "  " }, token);
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        var missing = await _client.PostAsJsonAsync("/api/notes/", new { }, token);
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
    }

    [Fact]
    public void ReadsDatabaseUrl()
    {
        var cs = NotesStore.ConnectionString("postgres://app:p%40ss@db:5433/notes");
        Assert.Contains("Host=db", cs);
        Assert.Contains("Port=5433", cs);
        Assert.Contains("Database=notes", cs);
        Assert.Contains("Username=app", cs);
        Assert.Contains("Password=p@ss", cs);
        Assert.IsType<MemoryNotesStore>(NotesStore.FromDatabaseUrl(null));
    }
}
