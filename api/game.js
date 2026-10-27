
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { QUESTIONS } from "./questions.js";

const hash = value =>
  createHash("sha256").update(value).digest("hex");

const makeToken = () => randomBytes(24).toString("hex");

const reply = (res, status, data) => res.status(status).json(data);

function db() {
  if (!process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase environment variables belum diatur.");
  }

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!["POST", "GET"].includes(req.method)) {
    return reply(res, 405, { error: "Method tidak didukung." });
  }

  try {
    const supabase = db();
    const input = req.method === "GET" ? req.query : (req.body || {});
    const action = input.action;

    async function getRoom(pin) {
      const { data, error } = await supabase
        .from("rooms").select("*").eq("pin", pin).maybeSingle();

      if (error) throw error;
      return data;
    }

    async function updateSignal(pin) {
      const { error } = await supabase
        .from("room_updates")
        .insert({ pin });

      if (error) throw error;
    }

    if (action === "create") {
      const hostToken = makeToken();
      let pin, room;

      for (let i = 0; i < 20; i++) {
        pin = String(Math.floor(100000 + Math.random() * 900000));
        room = await getRoom(pin);
        if (!room) break;
      }

      if (room) {
        return reply(res, 500, { error: "Gagal membuat PIN. Coba lagi." });
      }

      const { error } = await supabase.from("rooms").insert({
        pin,
        host_token_hash: hash(hostToken),
        status: "lobby",
        question_index: 0
      });

      if (error) throw error;
      await updateSignal(pin);

      return reply(res, 200, { pin, hostToken });
    }

    if (action === "join") {
      const pin = String(input.pin || "").trim();
      const name = String(input.name || "").trim().slice(0, 20);

      if (!/^\d{6}$/.test(pin) || !name) {
        return reply(res, 400, {
          error: "Masukkan PIN 6 digit dan nama pemain."
        });
      }

      const room = await getRoom(pin);
      if (!room) return reply(res, 404, { error: "Room tidak ditemukan." });
      if (room.status !== "lobby") {
        return reply(res, 400, { error: "Game sudah dimulai." });
      }

      const { count, error: countError } = await supabase
        .from("players")
        .select("*", { count: "exact", head: true })
        .eq("pin", pin);

      if (countError) throw countError;
      if (count >= 5) {
        return reply(res, 400, { error: "Room penuh. Maksimal 5 pemain." });
      }

      const playerToken = makeToken();
      const { error } = await supabase.from("players").insert({
        pin,
        name,
        token_hash: hash(playerToken),
        score: 0,
        answered_index: -1
      });

      if (error) {
        if (error.code === "23505") {
          return reply(res, 400, {
            error: "Nama sudah digunakan di room ini."
          });
        }
        throw error;
      }

      await updateSignal(pin);
      return reply(res, 200, { pin, name, playerToken });
    }

    const pin = String(input.pin || "").trim();
    if (!/^\d{6}$/.test(pin)) {
      return reply(res, 400, { error: "PIN tidak valid." });
    }

    const room = await getRoom(pin);
    if (!room) return reply(res, 404, { error: "Room tidak ditemukan." });

    if (action === "state") {
      const { data: players, error } = await supabase
        .from("players")
        .select("name,score,answered_index")
        .eq("pin", pin)
        .order("score", { ascending: false });

      if (error) throw error;

      const isHost = Boolean(
        input.hostToken &&
        hash(String(input.hostToken)) === room.host_token_hash
      );

      let me = null;

      if (input.playerToken) {
        const { data } = await supabase
          .from("players")
          .select("name,score,answered_index")
          .eq("pin", pin)
          .eq("token_hash", hash(String(input.playerToken)))
          .maybeSingle();

        me = data || null;
      }

      const q = QUESTIONS[room.question_index] || null;
      const seconds = room.question_started_at
        ? Math.max(
            0,
            15 - Math.floor(
              (Date.now() - new Date(room.question_started_at).getTime()) / 1000
            )
          )
        : 15;

      return reply(res, 200, {
        pin,
        status: room.status,
        questionIndex: room.question_index,
        questionStartedAt: room.question_started_at,
        question: q ? {
          number: room.question_index + 1,
          total: QUESTIONS.length,
          category: q.category,
          question: q.question,
          options: q.options
        } : null,
        players: players.map(p => ({
          name: p.name,
          score: p.score,
          answered: p.answered_index === room.question_index
        })),
        isHost,
        me,
        seconds,
        totalQuestions: QUESTIONS.length
      });
    }

    if (!input.hostToken ||
        hash(String(input.hostToken)) !== room.host_token_hash) {
      // Jawaban pemain memakai token pemain, bukan token host.
      if (action !== "answer") {
        return reply(res, 403, { error: "Aksi ini khusus host/guru." });
      }
    }

    if (action === "start") {
      if (room.status !== "lobby") {
        return reply(res, 400, { error: "Game sudah dimulai." });
      }

      const { error } = await supabase.from("rooms").update({
        status: "question",
        question_index: 0,
        question_started_at: new Date().toISOString()
      }).eq("pin", pin);

      if (error) throw error;
      await updateSignal(pin);
      return reply(res, 200, { ok: true });
    }

    if (action === "next") {
      if (room.status !== "question") {
        return reply(res, 400, { error: "Tidak ada soal aktif." });
      }

      const nextIndex = room.question_index + 1;
      const finished = nextIndex >= QUESTIONS.length;

      const { error } = await supabase.from("rooms").update({
        status: finished ? "finished" : "question",
        question_index: nextIndex,
        question_started_at: finished ? null : new Date().toISOString()
      }).eq("pin", pin);

      if (error) throw error;
      await updateSignal(pin);
      return reply(res, 200, { ok: true, finished });
    }

    if (action === "answer") {
      const playerToken = String(input.playerToken || "");
      const choice = Number(input.choice);

      if (!playerToken || !Number.isInteger(choice) ||
          choice < 0 || choice > 3) {
        return reply(res, 400, { error: "Jawaban tidak valid." });
      }

      if (room.status !== "question") {
        return reply(res, 400, { error: "Belum ada soal aktif." });
      }

      const elapsed = Date.now() -
        new Date(room.question_started_at).getTime();

      if (elapsed > 15000) {
        return reply(res, 400, { error: "Waktu menjawab habis." });
      }

      const { data: player, error: playerError } = await supabase
        .from("players")
        .select("*")
        .eq("pin", pin)
        .eq("token_hash", hash(playerToken))
        .maybeSingle();

      if (playerError) throw playerError;
      if (!player) return reply(res, 403, { error: "Token pemain salah." });

      if (player.answered_index === room.question_index) {
        return reply(res, 400, { error: "Jawaban sudah dikirim." });
      }

      const correct = choice === QUESTIONS[room.question_index].answer;
      const points = correct
        ? Math.max(0, Math.round(1000 * (1 - elapsed / 15000)))
        : 0;

      const { error } = await supabase.from("players").update({
        score: player.score + points,
        answered_index: room.question_index
      }).eq("id", player.id);

      if (error) throw error;
      await updateSignal(pin);

      return reply(res, 200, { ok: true, correct, points });
    }

    return reply(res, 400, { error: "Action tidak dikenal." });

  } catch (error) {
    console.error("QuizArena error:", error.message);
    return reply(res, 500, {
      error: "Server error. Periksa konfigurasi Supabase."
    });
  }
}
