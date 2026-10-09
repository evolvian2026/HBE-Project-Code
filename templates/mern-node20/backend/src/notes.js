import mongoose from "mongoose";

/** A note: the example resource. Replace it with your assignment's. */
export const Note = mongoose.model(
  "Note",
  new mongoose.Schema({ title: { type: String, required: true, trim: true, maxlength: 200 }, done: Boolean }),
);

/** A problem with a new note's input, or null. */
export function noteProblem(body) {
  if (typeof body?.title !== "string" || !body.title.trim()) return "title is required";
  if (body.title.length > 200) return "title must be at most 200 characters";
  return null;
}

/** The JSON shape the API returns. */
export const toJson = (note) => ({ id: String(note._id), title: note.title, done: Boolean(note.done) });
