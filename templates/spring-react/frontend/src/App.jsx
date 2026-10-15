import { useEffect, useState } from "react";

/** The example page: lists notes and adds new ones through the API. Replace it with yours. */
export default function App() {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/notes/")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setNotes)
      .catch((err) => setError(`Could not load notes: ${err.message}`));
  }, []);

  async function add(event) {
    event.preventDefault();
    const res = await fetch("/api/notes/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return setError(`Could not add the note: HTTP ${res.status}`);
    const note = await res.json();
    setNotes((current) => [...current, note]);
    setTitle("");
    setError(null);
  }

  return (
    <main>
      <h1>Notes</h1>
      <form onSubmit={add}>
        <label>
          New note <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <button type="submit">Add</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <ul aria-label="Notes">
        {notes.map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
    </main>
  );
}
