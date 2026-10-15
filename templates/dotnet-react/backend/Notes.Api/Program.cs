using Notes.Api;

// The app. Start here: the example notes API is below; its storage is in NotesStore.cs.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => NotesStore.FromDatabaseUrl(Environment.GetEnvironmentVariable("DATABASE_URL")));
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/notes/", async (INotesStore store) => Results.Ok(await store.ListAsync()));

app.MapPost("/api/notes/", async (NewNote? body, INotesStore store) =>
{
    var title = body?.Title?.Trim() ?? "";
    if (title.Length == 0)
    {
        return Results.BadRequest(new { error = "title is required" });
    }
    var note = await store.AddAsync(title);
    return Results.Created($"/api/notes/{note.Id}", note);
});

app.Run();

/// <summary>What POST /api/notes/ accepts.</summary>
public record NewNote(string? Title);

/// <summary>The app's entry point (the tests start it with WebApplicationFactory).</summary>
public partial class Program;
