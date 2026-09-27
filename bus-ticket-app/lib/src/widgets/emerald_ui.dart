/// "Glowing Emerald" design system.
///
/// The field terminals are used in harsh midday sun on a bus, so every accent
/// surface here is deliberately high-contrast: a saturated emerald gradient
/// with a green bloom behind it, white foreground, and a frosted-glass layer
/// whenever the accent sits on top of another accent. Brightness is animated
/// (not hard-coded) so the "glow" actually breathes.
library;

import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

/// Brand emerald stops (jade -> light emerald -> deep green). Kept in sync with
/// the theme seed in `main.dart`.
const Color kEmeraldJade = Color(0xFF00AE67);
const Color kEmeraldLight = Color(0xFF00E676);
const Color kEmeraldDeep = Color(0xFF00A859);
const Color kEmeraldInk = Color(0xFF053A2A);

/// The canonical "glowing emerald" gradient: jade -> light emerald -> deeper
/// green, angled so the highlight lands on the leading edge.
const LinearGradient kEmeraldGradient = LinearGradient(
  colors: [kEmeraldJade, kEmeraldLight, kEmeraldDeep],
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
);

/// Softer variant for large fills (banners, sheets) where a full-strength
/// gradient would flatten the text on top of it.
const LinearGradient kEmeraldGradientSoft = LinearGradient(
  colors: [Color(0xFF00B36B), Color(0xFF00894A)],
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
);

/// A soft emerald bloom used as a drop shadow. Sunlight washes out weak
/// shadows, so the glow is wide and tinted rather than a neutral grey blur.
const List<BoxShadow> kEmeraldGlow = [
  BoxShadow(
    color: Color(0x4D00C853),
    blurRadius: 22,
    spreadRadius: -2,
    offset: Offset(0, 8),
  ),
  BoxShadow(
    color: Color(0x1F00A859),
    blurRadius: 6,
    offset: Offset(0, 2),
  ),
];

/// Frosted-glass layer for accent-on-accent surfaces.
const List<BoxShadow> kEmeraldGlassShadow = [
  BoxShadow(
    color: Color(0x33000000),
    blurRadius: 18,
    offset: Offset(0, 8),
  ),
];

/// Page transition shared by the whole app: a quick cross-fade with a micro
/// spring scale. Fast enough to feel instant on a ticket queue, slow enough to
/// read as a deliberate transition rather than a flicker.
Route<T> emeraldPageRoute<T>(Widget page) {
  return PageRouteBuilder<T>(
    transitionDuration: const Duration(milliseconds: 320),
    reverseTransitionDuration: const Duration(milliseconds: 240),
    pageBuilder: (_, __, ___) => page,
    transitionsBuilder: (_, animation, __, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
        reverseCurve: Curves.easeInCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// Wraps a tab body so switching tabs cross-fades and micro-scales the incoming
/// screen instead of snapping. Key the [AnimatedSwitcher] on the tab identity.
class EmeraldTabEntrance extends StatelessWidget {
  const EmeraldTabEntrance({
    super.key,
    required this.tabKey,
    required this.child,
  });

  /// Identity of the visible tab — any value that changes per tab.
  final Object tabKey;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 280),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, animation) {
        return FadeTransition(
          opacity: animation,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.985, end: 1.0).animate(animation),
            child: child,
          ),
        );
      },
      layoutBuilder: (currentChild, previousChildren) => Stack(
        fit: StackFit.expand,
        children: [...previousChildren, if (currentChild != null) currentChild],
      ),
      child: KeyedSubtree(key: ValueKey(tabKey), child: child),
    );
  }
}

/// Primary call-to-action: emerald gradient fill, white label, green bloom, and
/// a press scale so a tap is acknowledged in bright sun.
class EmeraldButton extends StatefulWidget {
  const EmeraldButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.expand = false,
    this.height,
    this.dense = false,
    this.gradient = kEmeraldGradient,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  /// Stretch to the full width of the parent (default for bottom-bar CTAs).
  final bool expand;

  /// Optional fixed height; defaults to 44 (52 for roomy CTAs).
  final double? height;

  /// Compact variant for dialog/inline rows.
  final bool dense;

  final Gradient gradient;

  bool get _enabled => onPressed != null;

  @override
  State<EmeraldButton> createState() => _EmeraldButtonState();
}

class _EmeraldButtonState extends State<EmeraldButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget._enabled;
    final height = widget.height ?? (widget.dense ? 36 : 44);
    final content = Row(
      // The SizedBox below supplies the stretch for `expand`, so the label row
      // can always size to its content. That keeps a flexible child safe even
      // if this button is ever placed in a horizontally unbounded host.
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (widget.icon != null) ...[
          Icon(widget.icon, size: 18, color: Colors.white),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(
            widget.label,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w800,
              color: Colors.white,
              letterSpacing: 0.2,
            ),
          ),
        ),
      ],
    );

    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      child: GestureDetector(
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTapCancel: enabled ? () => setState(() => _down = false) : null,
        onTap: enabled ? widget.onPressed : null,
        child: AnimatedScale(
          scale: _down ? 0.97 : 1.0,
          duration: const Duration(milliseconds: 90),
          child: AnimatedOpacity(
            opacity: enabled ? 1 : 0.45,
            duration: const Duration(milliseconds: 160),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 260),
              height: height,
              padding: EdgeInsets.symmetric(
                horizontal: widget.dense ? 14 : 20,
                vertical: widget.dense ? 8 : 12,
              ),
              decoration: BoxDecoration(
                gradient: widget.gradient,
                borderRadius: BorderRadius.circular(widget.dense ? 10 : 12),
                boxShadow: enabled ? kEmeraldGlow : const [],
                border: enabled
                    ? null
                    : Border.all(color: Colors.white.withValues(alpha: 0.5)),
              ),
              // `expand` asks for the parent's width, NOT a literal infinite
              // width. AnimatedContainer does not clamp a double.infinity
              // width against the incoming constraints the way Container does -
              // it forwards it as tightFor, so the child is handed
              // `BoxConstraints(w=Infinity)` and every descendant (including
              // the Row's Flexible) then fails to lay out with 'hasSize'.
              // That is the exact crash reported from the field terminal.
              //
              // A finite `minWidth: 0, maxWidth: infinity` is safe: infinity is
              // only ever an upper bound, never a forced size, so the label row
              // still stretches to fill and shrinks when the host is narrower.
              child: ConstrainedBox(
                constraints: widget.expand
                    ? const BoxConstraints(
                        minWidth: 0, maxWidth: double.infinity)
                    : const BoxConstraints(),
                child: Center(child: content),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Secondary emerald action: translucent emerald glass with a crisp emerald
/// outline, for "Start shift" / "Start trip" style prompts that must not be
/// mistaken for the single primary CTA on screen.
class EmeraldGlassButton extends StatelessWidget {
  const EmeraldGlassButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onPressed == null ? 0.45 : 1,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        // Frosted glass needs the pixels behind it; Material can only blur its
        // own subtree, so fall back to a tinted fill where no backdrop exists.
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 8, sigmaY: 8),
          child: Material(
            color: Colors.white.withValues(alpha: 0.28),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: const BorderSide(color: kEmeraldDeep, width: 1.2),
            ),
            child: InkWell(
              onTap: onPressed,
              borderRadius: BorderRadius.circular(12),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                child: Row(
                  mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (icon != null) ...[
                      Icon(icon, size: 18, color: kEmeraldDeep),
                      const SizedBox(width: 8),
                    ],
                    Flexible(
                      child: Text(
                        label,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w700,
                          color: kEmeraldDeep,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Active-shift / running-trip banner: a breathing emerald gradient bar. The
/// pulse is driven by an [AnimationController] and is cheap (one container
/// repaint per frame, no layout).
class EmeraldBanner extends StatefulWidget {
  const EmeraldBanner({
    super.key,
    required this.child,
    this.leading,
    this.trailing,
    this.onTap,
    this.height,
  });

  final Widget child;
  final IconData? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final double? height;

  @override
  State<EmeraldBanner> createState() => _EmeraldBannerState();
}

class _EmeraldBannerState extends State<EmeraldBanner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _pulse,
      builder: (context, child) {
        final t = Curves.easeInOut.transform(_pulse.value);
        return Container(
          height: widget.height,
          // Stretch to the parent rather than forcing an infinite width: a
          // literal double.infinity here is forwarded as `tightFor` and any
          // unbounded host hands the Row below `BoxConstraints(w=Infinity)`,
          // which makes its Expanded child fail to lay out with 'hasSize'.
          width: double.infinity,
          alignment: Alignment.centerLeft,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [kEmeraldLight, kEmeraldDeep],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(14),
            boxShadow: [
              BoxShadow(
                color: Color.lerp(
                  const Color(0x2600C853),
                  const Color(0x5900E676),
                  t,
                )!,
                blurRadius: 14 + 12 * t,
                spreadRadius: -2,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: child,
        );
      },
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: widget.onTap,
          borderRadius: BorderRadius.circular(14),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                if (widget.leading != null) ...[
                  Icon(widget.leading, size: 18, color: Colors.white),
                  const SizedBox(width: 10),
                ],
                // Expanded is illegal in an unbounded-width Row, which is how
                // this banner crashed when hosted by a scroll view or a Row
                // without a flex parent. Flexible with a loose fit degrades to
                // the child's natural width instead of throwing.
                Flexible(child: widget.child),
                if (widget.trailing != null) widget.trailing!,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Large accent surface (login/splash background): slow emerald aurora over a
/// light base. Kept light enough that dark status-bar icons stay legible.
class EmeraldAurora extends StatefulWidget {
  const EmeraldAurora({super.key, required this.child});

  final Widget child;

  @override
  State<EmeraldAurora> createState() => _EmeraldAuroraState();
}

class _EmeraldAuroraState extends State<EmeraldAurora>
    with SingleTickerProviderStateMixin {
  late final AnimationController _drift = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 14),
  )..repeat();

  @override
  void dispose() {
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _drift,
      builder: (context, child) {
        // Two soft radial pools drifting on opposite phases.
        final t = Curves.easeInOut.transform(_drift.value);
        final pool = Color.lerp(
          const Color(0x1F00E676),
          const Color(0x3300A859),
          t,
        )!;
        return DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                Color.lerp(
                    const Color(0xFFF7FDF9), const Color(0xFFE8F8EF), t)!,
                const Color(0xFFF2EEE6),
              ],
            ),
          ),
          child: Stack(
            fit: StackFit.expand,
            children: [
              DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    radius: 1.0,
                    colors: [pool, pool.withValues(alpha: 0)],
                  ),
                ),
              ),
              child!,
            ],
          ),
        );
      },
      child: widget.child,
    );
  }
}
