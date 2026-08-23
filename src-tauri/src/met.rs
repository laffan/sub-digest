//! The Metropolitan Museum of Art's open collection API — where cover pictures
//! come from. See <https://metmuseum.github.io>: no key, no quota beyond a
//! request rate, and the open-access pieces carry images anyone may print.
//!
//! A search is two kinds of call: one for the ids that match the theme, then
//! one per id for the piece itself. That's a dozen or so requests, which is why
//! it lives here rather than in the webview — and it's the same reason the
//! candidate list is capped rather than walked.

use futures::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const MET: &str = "https://collectionapi.metmuseum.org/public/collection/v1";
/// Object lookups run at the same width as Gmail's header fetches.
const DETAIL_CONCURRENCY: usize = 8;
/// The most pieces one search will show, however many the museum matched.
const MAX_RESULTS: usize = 40;
/// Ids looked at per result asked for, so a piece whose record turns out to
/// have no usable image doesn't leave a hole in the grid.
const CANDIDATES_PER_RESULT: usize = 2;

/// One piece of the collection, as the cover picker shows it. Field names match
/// `CoverArtwork` in `src/types.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    object_id: i64,
    title: String,
    artist: String,
    artist_bio: String,
    date: String,
    medium: String,
    credit_line: String,
    department: String,
    object_url: String,
    image_url: String,
    thumb_url: String,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").trim().to_string()
}

/// Reads one object record, or nothing when the museum has no picture of it.
/// `hasImages` filters the search, but a record can still come back with the
/// fields empty, and a cover with no picture is no cover at all.
fn artwork(value: &Value) -> Option<Artwork> {
    let full = text(value, "primaryImage");
    let small = text(value, "primaryImageSmall");
    if full.is_empty() && small.is_empty() {
        return None;
    }
    let title = text(value, "title");
    Some(Artwork {
        object_id: value["objectID"].as_i64().unwrap_or(0),
        title: if title.is_empty() {
            text(value, "objectName")
        } else {
            title
        },
        artist: text(value, "artistDisplayName"),
        artist_bio: text(value, "artistDisplayBio"),
        date: text(value, "objectDate"),
        medium: text(value, "medium"),
        credit_line: text(value, "creditLine"),
        department: text(value, "department"),
        object_url: text(value, "objectURL"),
        // The web-sized copy is the fallback for both: it's what the grid wants
        // anyway, and it beats printing nothing.
        image_url: if full.is_empty() { small.clone() } else { full },
        thumb_url: if small.is_empty() {
            text(value, "primaryImage")
        } else {
            small
        },
    })
}

async fn get_json(url: &str) -> Result<Value, String> {
    let resp = crate::gmail::http()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("the Met's API could not be reached: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the Met's API answered HTTP {}", resp.status()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("the Met's API sent something unreadable: {e}"))
}

/// Searches the open-access collection for `query` and returns up to `limit`
/// pieces that have a picture, in the order the museum ranked them.
#[tauri::command]
pub async fn met_search(
    app: AppHandle,
    query: String,
    limit: usize,
) -> Result<Vec<Artwork>, String> {
    let theme = query.trim();
    if theme.is_empty() {
        return Err("a theme is needed to search on".to_string());
    }
    let want = limit.clamp(1, MAX_RESULTS);

    // `isPublicDomain` is what makes the result printable, and it's also what
    // guarantees the image fields are filled in.
    let url = format!(
        "{MET}/search?hasImages=true&isPublicDomain=true&q={}",
        urlencoding(theme)
    );
    crate::log::info(
        &app,
        "cover",
        format!("Met search: {}", crate::log::ellipsize(&url, 160)),
    );
    let found = get_json(&url).await?;
    let ids: Vec<i64> = found["objectIDs"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();
    crate::log::info(
        &app,
        "cover",
        format!(
            "{} open-access pieces match \"{theme}\"; looking at the first {}",
            found["total"].as_i64().unwrap_or(ids.len() as i64),
            ids.len().min(want * CANDIDATES_PER_RESULT)
        ),
    );
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    // Ordered, not unordered: the museum's ranking is the only ordering the grid
    // has, and buffering out of order would scramble it. `take` closes the
    // stream once the grid is full, so the ids beyond it are never asked for —
    // they're there for the records that come back with no picture on them.
    let out: Vec<Artwork> = stream::iter(ids.into_iter().take(want * CANDIDATES_PER_RESULT).map(
        |id| async move {
            match get_json(&format!("{MET}/objects/{id}")).await {
                Ok(value) => artwork(&value),
                // One unreachable record shouldn't cost the whole search.
                Err(_) => None,
            }
        },
    ))
    .buffered(DETAIL_CONCURRENCY)
    .filter_map(|record| async move { record })
    .take(want)
    .collect()
    .await;
    crate::log::info(&app, "cover", format!("{} pieces with pictures", out.len()));
    Ok(out)
}

/// Percent-encodes a search term for the query string. The museum's search
/// takes free text, so anything the user types has to survive the trip intact.
fn urlencoding(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_theme_survives_the_query_string() {
        assert_eq!(urlencoding("winter light"), "winter+light");
        assert_eq!(urlencoding("Monet & Manet"), "Monet+%26+Manet");
    }

    #[test]
    fn a_record_without_a_picture_is_no_cover() {
        let value: Value = serde_json::json!({
            "objectID": 1,
            "title": "A thing",
            "primaryImage": "",
            "primaryImageSmall": ""
        });
        assert!(artwork(&value).is_none());
    }

    #[test]
    fn the_web_sized_copy_stands_in_for_a_missing_original() {
        let value: Value = serde_json::json!({
            "objectID": 436524,
            "title": "Sunflowers",
            "artistDisplayName": "Vincent van Gogh",
            "objectDate": "1887",
            "primaryImage": "",
            "primaryImageSmall": "https://images.metmuseum.org/web-large/DT1567.jpg"
        });
        let art = artwork(&value).expect("a piece with a web image is usable");
        assert_eq!(art.image_url, art.thumb_url);
        assert_eq!(art.artist, "Vincent van Gogh");
    }

    /// A piece the museum holds but nobody is credited with.
    #[test]
    fn an_untitled_piece_falls_back_to_what_it_is() {
        let value: Value = serde_json::json!({
            "objectID": 2,
            "title": "",
            "objectName": "Woodblock print",
            "primaryImage": "https://images.metmuseum.org/original/x.jpg",
            "primaryImageSmall": "https://images.metmuseum.org/web-large/x.jpg"
        });
        let art = artwork(&value).expect("a piece with an image is usable");
        assert_eq!(art.title, "Woodblock print");
        assert_eq!(art.artist, "");
    }
}
