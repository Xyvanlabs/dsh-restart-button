/**
 * dsh-restart-button — client half.
 *
 * Renders the「重启」entry in the sidebar foot, in the `sidebar.footer.action`
 * list slot right beside the Settings gear, and calls the host route that
 * restarts the app and its host.
 *
 * The row copies the shipped Settings trigger geometry (42px tall, same
 * padding/gap/font, `--dsw-alias-interactive-bg-hover` on hover) so it reads as
 * part of the foot rather than a bolted-on widget. In the collapsed rail the
 * foot area is display:none, so the same component renders a 36px round icon
 * button instead of a labelled row.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var jsxRuntime = require('react/jsx-runtime');
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;

    var TOOLTIP_KEY = 'restart-button';

    /* Every place that can show this entry — the row label, the native hover
       tooltip, and the accessible name that plugins such as dsh-claude-style
       mirror into their account popover — reads the same short word. Themes
       prefer `aria-label` over the visible text when mirroring a footer entry,
       so a descriptive accessible name would leak its whole sentence into their
       popover. Failure reasons reach the hover tooltip only, and only while the
       failure is live. */
    var DICTIONARIES = {
      zh: { label: '重启', busy: '重启中…', failed: '重启失败', timeout: '重启超时' },
      en: { label: 'Restart', busy: 'Restarting…', failed: 'Restart failed', timeout: 'Restart timed out' }
    };

    function dictionary() {
      var lang = String(document.documentElement.lang || '').toLowerCase();
      return lang.indexOf('zh') === 0 ? DICTIONARIES.zh : DICTIONARIES.en;
    }

    /** Restart arrow (same geometry as the primitives' refresh icon). */
    var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M13.4 8A5.4 5.4 0 1 1 11.4 3.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M13.7 2.4v3.1h-3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';

    var CSS = [
      /* Wide row: same height/padding/gap/font as .wCInkW_trigger (the Settings
         button) so it reads as part of the foot.
         Width is content-sized on purpose. Other plugins may lay the foot out as
         one horizontal line (balance-dsh turns footerActions into a
         justify-content:flex-end row) and an item that asks for width:100% with
         flex:none steals the whole line and pushes its neighbour out of view.
         flex:0 0 auto keeps only the natural width (icon + label + padding).
         Shrinking is deliberately disabled: the balance row always claims
         width:100%, so a shrinkable item would ellipsize its label at every
         width instead of only when space is short. max-width:100% still clamps
         the row inside the foot, and overflow:hidden clips instead of spilling. */
      '.row{box-sizing:border-box;display:flex;align-items:center;gap:8px;',
      '  flex:0 0 auto;width:auto;max-width:100%;min-width:0;',
      '  height:42px;margin:0;padding:0 10px 0 8px;',
      '  border:0;border-radius:var(--dsw-radius-md,8px);background:0 0;',
      '  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;',
      '  text-align:left;white-space:nowrap;overflow:hidden;cursor:pointer;',
      '  -webkit-user-select:none;user-select:none;',
      '  transition:background-color 120ms ease,color 120ms ease}',
      '.row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}',
      '.row[data-busy="true"]{opacity:.55;cursor:default}',
      '.row[data-failed="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.row__icon{display:inline-flex;flex:none}',
      '.row__icon svg{display:block}',
      /* Shrinks before the icon: the label truncates first, the icon never does. */
      '.row__label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* Collapsed rail: the foot area itself is display:none, so this variant is
         only reached when the host renders actions outside it. */
      '.row--rail{justify-content:center;gap:0;width:36px;height:36px;padding:0;margin:0 auto}'
    ].join('\n');

    function injectCSS() {
      if (typeof document === 'undefined') return;
      var id = 'dsh-restart-button';
      if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = id;
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function RestartButton(props) {
      var wide = props.wide !== false;
      var lang = String(document.documentElement.lang || '').toLowerCase();
      var text = lang.indexOf('zh') === 0 ? DICTIONARIES.zh : DICTIONARIES.en;
      var state = react.useState({ busy: false, failed: false, note: null });
      var view = state[0];
      var setView = state[1];
      var timer = react.useRef(null);

      react.useEffect(function () {
        return function () {
          if (timer.current !== null) clearTimeout(timer.current);
        };
      }, []);

      function later(fn, delay) {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          timer.current = null;
          fn();
        }, delay);
      }

      function restart() {
        if (view.busy) return;
        setView({ busy: true, failed: false, note: null });
        fetch('/restart-button/restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store'
        }).then(function (response) {
          if (response.ok) {
            // The app goes down within a second or two; if it does not, undo
            // the busy state instead of leaving the row stuck on「重启中…」.
            later(function () {
              setView({ busy: false, failed: false, note: text.timeout });
            }, 45000);
            return null;
          }
          return response.json().catch(function () { return {}; }).then(function (body) {
            throw new Error((body && body.error) ? String(body.error) : ('HTTP ' + response.status));
          });
        }).catch(function (error) {
          var reason = (error && error.message) ? String(error.message) : String(error);
          console.warn('[restart-button] restart failed:', reason);
          setView({ busy: false, failed: true, note: reason });
          later(function () {
            setView({ busy: false, failed: false, note: null });
          }, 8000);
        });
      }

      var label = view.busy ? text.busy : (view.failed ? text.failed : text.label);
      // The accessible name stays the plain「重启」in every state, because themes
      // mirror it verbatim into their own menus; only the hover title carries
      // the failure reason, and only while that reason is live.
      var title = view.note === null ? text.label : (text.label + ' — ' + view.note);

      return jsx('button', {
        type: 'button',
        className: wide ? 'row' : 'row row--rail',
        title: title,
        'aria-label': text.label,
        'data-busy': view.busy ? 'true' : 'false',
        'data-failed': view.failed ? 'true' : 'false',
        onClick: restart,
        onPointerDown: function (event) { event.stopPropagation(); },
        dangerouslySetInnerHTML: {
          __html: '<span class="row__icon">' + ICON + '</span>' +
            (wide ? '<span class="row__label">' + escapeHTML(label) + '</span>' : '')
        }
      });
    }

    function escapeHTML(value) {
      return String(value).replace(/[&<>"']/g, function (ch) {
        return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
      });
    }

    var inject = ['slots'];

    function apply(ctx) {
      if (typeof document === 'undefined') return;
      injectCSS();
      // Lazy: the callback runs when the sidebar mounts the foot and again on
      // every re-registration, so registering unconditionally here is enough.
      var register = function () {
        ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: TOOLTIP_KEY, order: 10 },
            RestartButton
          );
        });
      };
      if (document.body === null) {
        document.addEventListener('DOMContentLoaded', register, { once: true });
      } else {
        register();
      }
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.name = 'restart-button';
    return module.exports;
  }
});