import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import psutil
from tokenizers import Tokenizer


def encode(text, tokenizer):
    encoded = tokenizer.encode(text)
    return {
        "input_ids": np.array([encoded.ids], dtype=np.int64),
        "attention_mask": np.array([encoded.attention_mask], dtype=np.int64),
        "token_type_ids": np.array([encoded.type_ids], dtype=np.int64),
    }


def pooled(hidden, mask):
    weights = mask[:, :, None].astype(np.float32)
    value = (hidden.astype(np.float32) * weights).sum(axis=1) / weights.sum(axis=1)
    norm = np.linalg.norm(value, axis=1, keepdims=True)
    if not np.isfinite(value).all() or (norm < 1e-8).any():
        raise ValueError("The embedding model returned an invalid vector.")
    return (value / norm)[0].tolist()


def load(model_directory):
    tokenizer = Tokenizer.from_file(str(model_directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding(length=256, pad_id=0, pad_token="[PAD]")
    model_path = str(model_directory / "model.onnx")
    warning = None
    if sys.platform == "win32":
        import openvino as ov

        core = ov.Core()
        device = "NPU" if "NPU" in core.available_devices else "CPU"
        if device == "CPU":
            warning = "Intel NPU unavailable. Install or update the Intel AI Boost NPU driver on Windows 11. CPU fallback is active."
        model = core.read_model(model_path)
        model.reshape({port.any_name: [1, 256] for port in model.inputs})
        config = {"CACHE_DIR": str(model_directory / "compiled")}
        if device == "CPU":
            config["INFERENCE_NUM_THREADS"] = 2
        try:
            compiled = core.compile_model(model, device, config)
        except RuntimeError as error:
            if device != "NPU":
                raise
            warning = f"Intel NPU model compilation failed; CPU fallback is active. Check the Intel NPU driver and runtime compatibility. {error}"
            compiled = core.compile_model(model, "CPU", {
                "CACHE_DIR": str(model_directory / "compiled"), "INFERENCE_NUM_THREADS": 2,
            })
            device = "CPU"

        def infer(inputs):
            result = compiled(inputs)
            return result[compiled.output(0)]

        infer(encode("Working Memory model readiness check", tokenizer))
        execution = compiled.get_property("EXECUTION_DEVICES")
        backend = "OpenVINO / " + ", ".join(execution)
    else:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.enable_profiling = True
        options.profile_file_prefix = str(model_directory / "provider-check")
        options.add_free_dimension_override_by_name("batch_size", 1)
        options.add_free_dimension_override_by_name("sequence_length", 256)
        providers = ["CPUExecutionProvider"]
        if sys.platform == "darwin" and "CoreMLExecutionProvider" in ort.get_available_providers():
            providers.insert(0, ("CoreMLExecutionProvider", {
                "ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndGPU",
                "RequireStaticInputShapes": "1",
            }))
        try:
            session = ort.InferenceSession(model_path, sess_options=options, providers=providers)
        except RuntimeError as error:
            if len(providers) == 1:
                raise
            warning = f"Core ML initialization failed; CPU fallback is active. {error}"
            session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
        names = {port.name for port in session.get_inputs()}

        def infer(inputs):
            return session.run(None, {name: value for name, value in inputs.items() if name in names})[0]

        infer(encode("Working Memory model readiness check", tokenizer))
        profile = Path(session.end_profiling())
        try:
            events = json.loads(profile.read_text())
            observed = {event.get("args", {}).get("provider") for event in events}
            observed.discard(None)
        finally:
            profile.unlink(missing_ok=True)
        if "CoreMLExecutionProvider" in observed:
            backend = "Core ML + CPU (GPU permitted)" if "CPUExecutionProvider" in observed else "Core ML (GPU permitted)"
        else:
            backend = "ONNX Runtime / CPU"
            if sys.platform == "darwin" and warning is None:
                warning = "This model did not execute through Core ML. CPU fallback is active."
    return tokenizer, infer, backend, warning


def respond(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    directory = Path(sys.argv[1])
    try:
        tokenizer, infer, backend, warning = load(directory)
    except Exception as error:
        respond({"ready": False, "error": f"Embedding runtime could not start: {error}"})
        return 1
    process = psutil.Process(os.getpid())
    respond({"ready": True, "backend": backend, "warning": warning, "rssBytes": process.memory_info().rss})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            texts = request["texts"]
            if not isinstance(texts, list) or not 1 <= len(texts) <= 80:
                raise ValueError("Expected between one and 80 passages.")
            if any(not isinstance(text, str) or not 1 <= len(text) <= 1400 for text in texts):
                raise ValueError("Invalid embedding passage.")
            started = time.perf_counter()
            vectors = []
            for text in texts:
                inputs = encode(text, tokenizer)
                vectors.append(pooled(infer(inputs), inputs["attention_mask"]))
            respond({"id": request["id"], "vectors": vectors,
                     "durationMs": (time.perf_counter() - started) * 1000,
                     "rssBytes": process.memory_info().rss})
        except Exception as error:
            respond({"id": request.get("id") if isinstance(request, dict) else None,
                     "error": f"Embedding inference failed: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
