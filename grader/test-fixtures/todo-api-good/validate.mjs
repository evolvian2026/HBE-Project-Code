/** A todo's title: a non-empty string of at most 200 characters. */
export const validTitle = (title) => typeof title === "string" && title.trim().length > 0 && title.length <= 200;
