import { createElement, useEffect, useRef } from "react";
import type { Block, DigestPost } from "../types";
import { formatLongDate } from "../dates";

interface Props {
  posts: DigestPost[];
  preparing: boolean;
}

/**
 * The parsed content as it accrues, one post at a time. This is what the
 * exporters will lay out — the point is to see what was actually captured
 * (and in what order) before spending time generating a document.
 */
export function ContentPreview({ posts, preparing }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  // Follow along as posts land, but only while they're still arriving — once
  // it's done the reader owns the scroll position.
  useEffect(() => {
    if (preparing) endRef.current?.scrollIntoView({ block: "end" });
  }, [posts, preparing]);

  if (posts.length === 0) {
    return (
      <div className="preview-empty">
        <p>Reading your posts</p>
        <p className="hint">Each one appears here as it's fetched and parsed.</p>
      </div>
    );
  }

  return (
    <div className="content-preview">
      {posts.map((post, i) => (
        <article className="cp-post" key={`${post.title}-${post.dateMs}`}>
          <p className="cp-pub">
            {i + 1}. {post.publication}
          </p>
          <h2 className="cp-title">{post.title}</h2>
          <p className="cp-date">{formatLongDate(post.dateMs)}</p>
          {post.blocks.map((block, b) => (
            <BlockView block={block} key={b} />
          ))}
        </article>
      ))}
      {preparing && <p className="cp-working">Preparing the next post…</p>}
      <div ref={endRef} />
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      // h1 belongs to the post title, so in-post headings start at h3 here.
      return createElement(`h${Math.min(6, Math.max(3, block.level + 2))}`, null, block.text);
    case "para":
      if (block.style === "quote") return <blockquote>{block.text}</blockquote>;
      if (block.style === "caption") return <p className="cp-caption">{block.text}</p>;
      return <p>{block.text}</p>;
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "image":
      // Images are fetched and re-encoded at generation time; this is a marker
      // so the shape of the post reads correctly.
      return <p className="cp-image">▣ image</p>;
    case "rule":
      return <hr />;
  }
}
