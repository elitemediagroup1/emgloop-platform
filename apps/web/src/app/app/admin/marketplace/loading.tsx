// The Decision Center's loading state.
//
// There was none. The route is `force-dynamic` and its load path is genuinely
// slow — one engine write per situation, sequentially, then one history read per
// decision, then the lane counts and the activity summary, which itself replays a
// log per closed decision. Until all of that resolved, the operator sat on the
// PREVIOUS page with no indication anything was happening, and a period change
// looked like a broken control.
//
// This is a shape, not a spinner: the brief, the lanes and three cards in their
// real proportions, so the layout does not jump when the content lands.
//
// IT CONTAINS NO NUMBERS AND NO WORDS FROM THE PAGE. A skeleton that guesses at
// counts, or reuses the last render's figures, shows an operator a value that was
// never measured — the same failure as a fabricated metric, only briefer. Every
// filled area here is a neutral block.
//
// Motion is one shimmer, and `prefers-reduced-motion` switches it off through the
// global rule in `loop-os.css`.

export default function DecisionCenterLoading() {
  return (
    <div className="loop-os">
      <div className="cmd cg-page" aria-busy="true" aria-live="polite">
        <p className="q-sr">Loading the Decision Center…</p>

        <div className="q-skel">
          {/* The brief */}
          <div className="q-skel__brief">
            <span className="q-skel__bar q-skel__bar--greet" />
            <span className="q-skel__bar q-skel__bar--verdict" />
            <span className="q-skel__bar q-skel__bar--why" />
            <div className="q-skel__row">
              {[0, 1, 2, 3].map((i) => <span className="q-skel__count" key={i} />)}
            </div>
            <div className="q-skel__focus">
              <span className="q-skel__focuscard" />
              <span className="q-skel__focuscard" />
            </div>
          </div>

          {/* The lanes */}
          <div className="q-skel__lanes">
            {[0, 1, 2, 3, 4].map((i) => <span className="q-skel__lane" key={i} />)}
          </div>

          {/* Three cards, in the primary tier's proportions */}
          {[0, 1, 2].map((i) => (
            <div className="q-skel__card" key={i}>
              <span className="q-skel__rail" />
              <div className="q-skel__cardbody">
                <span className="q-skel__bar q-skel__bar--title" />
                <span className="q-skel__bar q-skel__bar--action" />
                <span className="q-skel__bar q-skel__bar--line" />
                <div className="q-skel__row">
                  <span className="q-skel__chip" />
                  <span className="q-skel__chip" />
                  <span className="q-skel__chip" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
