-- An image's pixel size, keyed on its URL rather than on an event.
--
-- Facebook lays a share card out from og:image:width/height and will not wait while it
-- measures the picture itself, so a poster with no stated size shows as a bare link the
-- first time anyone shares the event. Our own card has a fixed size; a source's poster
-- does not, and the only way to know it is to read the file's first bytes.
--
-- Keyed on the URL because a poster is shared: 1,961 upcoming events carried only 694
-- distinct images when this was written — Barrie library's 598 listings use 46 posters
-- between them. Keyed on the event it would be fetched dozens of times and written dozens
-- of ways; keyed here, once.
--
-- width and height are NULL when the bytes did not state a size (an SVG, a file whose
-- JPEG frame header sat past the range fetched, a 404). The row still exists, so the pass
-- moves on instead of trying that URL again every two hours.
CREATE TABLE IF NOT EXISTS image_sizes (
  url        TEXT PRIMARY KEY,
  width      INTEGER,
  height     INTEGER,
  checked_at TEXT NOT NULL
);
