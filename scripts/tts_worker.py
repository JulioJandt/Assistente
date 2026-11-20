"""Trabalhador de voz do assistente (Piper).

Carrega o modelo de voz uma vez e fica lendo pedidos do stdin, um JSON por linha:
    {"text": "Olá", "length_scale": 1.1}
Para cada pedido responde no stdout com 4 bytes (tamanho, little-endian) + o WAV.
Tamanho 0 significa erro (detalhes no stderr).

Uso: python -I tts_worker.py <caminho-do-modelo.onnx>
"""

import io
import json
import struct
import sys
import wave

from piper import PiperVoice, SynthesisConfig


def main() -> None:
    voice = PiperVoice.load(sys.argv[1])
    sys.stderr.write("pronto\n")
    sys.stderr.flush()
    out = sys.stdout.buffer

    for line in sys.stdin.buffer:
        data = b""
        try:
            req = json.loads(line.decode("utf-8"))
            text = str(req.get("text", "")).strip()
            if text:
                config = SynthesisConfig(length_scale=req.get("length_scale"))
                buf = io.BytesIO()
                with wave.open(buf, "wb") as wav_file:
                    voice.synthesize_wav(text, wav_file, syn_config=config)
                data = buf.getvalue()
        except Exception as err:  # noqa: BLE001 - qualquer erro vira resposta vazia
            sys.stderr.write(f"erro: {err}\n")
            sys.stderr.flush()
        out.write(struct.pack("<I", len(data)))
        out.write(data)
        out.flush()


if __name__ == "__main__":
    main()
