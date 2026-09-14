-- Second opinions on price.
--
-- After a detail page has been read, a listing can still be unclear: plenty of community
-- events simply never say. A model is asked to find the sentence that states the price,
-- and the answer is cached here so the same words are never paid for twice.
--
-- Keyed by content hash as well as listing, so an edited listing is read again and an
-- unedited one never is.
CREATE TABLE IF NOT EXISTS cost_decisions (
  listing_id   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  -- What the rules made of the quoted sentence: 'free', 'paid', or 'unclear'.
  verdict      TEXT NOT NULL,
  -- The sentence the model pointed at, verified to appear in the listing's own text.
  quote        TEXT,
  method       TEXT NOT NULL,
  decided_at   TEXT NOT NULL,
  PRIMARY KEY (listing_id, content_hash)
);
