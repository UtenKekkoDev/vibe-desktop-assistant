use eframe::egui::{Align2, Color32, FontId, Painter, Rect, pos2, vec2};

pub const SIZE: [f32; 2] = [204.0, 54.0];
const GRID: usize = 9;
const FRAME_BYTES: usize = GRID * GRID * 3;
const KEYFRAMES_PER_SECOND: f32 = 30.0;

// Each frame stores only the RGB light levels of the 81 emitters, row by row.
// Calibration reference: https://x.com/guanmo_ai/status/2125789137353478251/video/1
const DIAMOND: &[u8; FRAME_BYTES * 60] = include_bytes!("../assets/processing/diamond.rgb");

struct LightFrame<'a> {
    current: &'a [u8],
    next: &'a [u8],
    blend: f32,
}

impl<'a> LightFrame<'a> {
    fn at(track: &'a [u8], time: f32) -> Self {
        let frames = track.len() / FRAME_BYTES;
        let phase = (time * KEYFRAMES_PER_SECOND).rem_euclid(frames as f32);
        let index = phase.floor() as usize % frames;
        let next = (index + 1) % frames;
        Self {
            current: &track[index * FRAME_BYTES..(index + 1) * FRAME_BYTES],
            next: &track[next * FRAME_BYTES..(next + 1) * FRAME_BYTES],
            blend: phase.fract(),
        }
    }

    fn color(&self, index: usize) -> [u8; 3] {
        std::array::from_fn(|channel| {
            let pos = index * 3 + channel;
            let a = f32::from(self.current[pos]);
            let b = f32::from(self.next[pos]);
            (a + (b - a) * self.blend).round() as u8
        })
    }
}

fn thinking_label(painter: &Painter, x: f32, cy: f32, time: f32) {
    // A narrow, tinted reflection crosses the word. The unlit text stays grey.
    const TINT: [u8; 3] = [255, 241, 213];
    let sweep = (time - 0.40 + 1.5).rem_euclid(3.0) - 1.5;
    let galley = painter.layout_no_wrap(
        "Thinking".into(),
        FontId::proportional(18.0),
        Color32::WHITE,
    );
    let origin = pos2(x, cy - galley.size().y * 0.5);
    // Snap strips to contiguous physical pixels so the moving light cannot leave seams.
    let ppp = painter.ctx().pixels_per_point();
    let left = (x * ppp).floor() as i32 - 1;
    let right = ((x + galley.size().x) * ppp).ceil() as i32 + 1;
    for start in (left..right).step_by(3) {
        let x0 = start as f32 / ppp;
        let x1 = (start + 3).min(right) as f32 / ppp;
        let u = ((x0 + x1) * 0.5 - x) / galley.size().x;
        let light = (-((u - 0.5 - sweep * 0.74) / 0.23).powi(2)).exp();
        let rgb = TINT.map(|v| (142.0 + (f32::from(v) - 142.0) * light).round() as u8);
        let clip = Rect::from_min_max(
            pos2(x0, origin.y - 2.0),
            pos2(x1, origin.y + galley.size().y + 2.0),
        );
        painter
            .with_clip_rect(clip)
            .galley_with_override_text_color(
                origin,
                galley.clone(),
                Color32::from_rgb(rgb[0], rgb[1], rgb[2]),
            );
    }
}

fn paint_capsule(painter: &Painter, rect: Rect, color: impl Fn(usize, usize) -> [u8; 3]) {
    let body = rect.shrink(1.0);
    painter.rect_filled(
        body.translate(vec2(0.0, 1.2)),
        body.height() * 0.5,
        Color32::from_black_alpha(58),
    );
    painter.rect_filled(body, body.height() * 0.5, Color32::BLACK);
    let cy = rect.center().y;
    for row in 0..GRID {
        for col in 0..GRID {
            let [r, g, b] = color(row, col);
            let center = pos2(
                rect.left() + 34.0 + (col as f32 - 4.0) * 4.76,
                cy + (row as f32 - 4.0) * 4.76,
            );
            let brightness = f32::from(r.max(g).max(b)) / 255.0;
            painter.circle_filled(
                center,
                3.05,
                Color32::from_rgba_unmultiplied(r, g, b, (34.0 * brightness) as u8),
            );
            painter.circle_filled(center, 1.84, Color32::from_rgb(r, g, b));
        }
    }
}

pub fn paint_recording(painter: &Painter, rect: Rect, level: f32, elapsed: &str, hint: &str) {
    // Keep the centre dark even at the smallest radius and the rim inside the grid.
    let amplitude = ((level - 0.012) / 0.988).clamp(0.0, 1.0).sqrt();
    let radius = 1.35 + amplitude * 2.65;
    paint_capsule(painter, rect, |row, col| {
        let distance = (row as f32 - 4.0).hypot(col as f32 - 4.0);
        let rim = (1.0 - ((distance - radius) / 0.9).powi(2)).max(0.0);
        let glow = rim * (0.53 + 0.47 * amplitude);
        [
            (35.0 + 220.0 * glow) as u8,
            (9.0 + 66.0 * glow * glow) as u8,
            (13.0 + 52.0 * glow * glow) as u8,
        ]
    });
    let x = rect.left() + 67.0;
    let cy = rect.center().y;
    painter.text(
        pos2(x, cy - 8.0),
        Align2::LEFT_CENTER,
        "正在听…",
        FontId::proportional(15.0),
        Color32::from_gray(229),
    );
    painter.text(
        pos2(rect.right() - 15.0, cy - 8.0),
        Align2::RIGHT_CENTER,
        elapsed,
        FontId::monospace(12.0),
        Color32::from_gray(174),
    );
    painter.text(
        pos2(x, cy + 10.0),
        Align2::LEFT_CENTER,
        hint,
        FontId::proportional(11.0),
        Color32::from_gray(162),
    );
}

pub fn paint(painter: &Painter, rect: Rect, time: f32, submitted: bool) {
    let frame = LightFrame::at(DIAMOND, time);
    paint_capsule(painter, rect, |row, col| frame.color(row * GRID + col));
    let x = rect.left() + 67.0;
    let cy = rect.center().y;
    if submitted {
        painter.text(
            pos2(x, cy - 8.0),
            Align2::LEFT_CENTER,
            "已提交搜索",
            FontId::proportional(15.0),
            Color32::from_gray(229),
        );
        painter.text(
            pos2(x, cy + 10.0),
            Align2::LEFT_CENTER,
            "正在核对 Steam 结果页",
            FontId::proportional(11.0),
            Color32::from_gray(162),
        );
    } else {
        thinking_label(painter, x, cy, time);
    }
}
