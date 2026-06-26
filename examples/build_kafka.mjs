// Kafka Event Streaming Architecture — type "pipeline" (LR data flow).
// Producers → Kafka Platform → Stream Processing → Sinks
import { writeFileSync } from "node:fs";
import { Diagram } from "../src/builder.mjs";
import { group, frame, icon, stage, band, endpoint, ossBox, renderTree } from "../src/layout-engine.mjs";

const d = new Diagram("pipeline");

// ── Stage 0: Producers ───────────────────────────────────────────────────────
const producers = stage("prod", 0, "1 · Producers", [
  icon("app",      "debezium",  "Debezium\n(CDC)"),
  icon("iot",      "kafka",     "App Events"),
  icon("logs",     "flink",     "Log Agents"),
], { gap: 36 });

// ── Stage 1: Kafka Platform ──────────────────────────────────────────────────
const kafka = stage("kafka", 1, "2 · Kafka Platform", [
  icon("broker",   "kafka",                      "Kafka Brokers"),
  icon("schema",   "confluent_schema_registry",  "Schema Registry"),
  icon("kconnect", "kafka",                      "Kafka Connect"),
], { gap: 36 });

// ── Stage 2: Stream Processing ───────────────────────────────────────────────
const process = stage("proc", 2, "3 · Stream Processing", [
  icon("flink_job", "flink",            "Apache Flink"),
  icon("ksql",      "confluent_ksqldb", "ksqlDB"),
], { gap: 36 });

// ── Stage 3: Sinks ────────────────────────────────────────────────────────────
const sinks = stage("sink", 3, "4 · Sinks", [
  icon("es",        "elasticsearch",  "Elasticsearch\n(search)"),
  icon("mongo",     "mongodb",        "MongoDB\n(docs)"),
  icon("redisdb",   "redis",          "Redis\n(cache)"),
  icon("warehouse", "spark",          "Spark\n(batch DW)"),
], { gap: 36 });

// ── Cross-cutting band ────────────────────────────────────────────────────────
const ops = band("ops", "Monitoring · Schema Governance · Security", [
  icon("prom",   "prometheus",   "Prometheus"),
  icon("graf",   "grafana",      "Grafana"),
  icon("otel",   "opentelemetry","OpenTelemetry"),
], { gap: 40 });

// ── Layout tree ──────────────────────────────────────────────────────────────
const pipe = frame("pipe", "", {
  dir: "row", gap: 50, align: "top", header: 0, fill: "none", stroke: "none",
}, [producers, kafka, process, sinks]);

const tree = frame("root", "", {
  dir: "col", gap: 30, header: 0, pad: 10, fill: "none", stroke: "none",
}, [
  frame("toprow", "", { dir: "row", gap: 30, align: "center", header: 0, pad: 0, fill: "none", stroke: "none" }, [
    endpoint("src",  "SOURCES\n\nDB · Apps\n· Logs · IoT"),
    pipe,
    endpoint("cons", "CONSUMERS\n\nAPIs · ML\n· Dashboards"),
  ]),
  ops,
]);

renderTree(d, tree, [40, 80]);
d.title("Kafka Event Streaming Architecture — type: pipeline");

// ── Edges: Producers → Kafka ─────────────────────────────────────────────────
d.link("src",     "app",      "CDC",       { role: "fanout" });
d.link("src",     "iot",      "events",    { role: "fanout" });
d.link("src",     "logs",     "logs",      { role: "fanout" });

d.link("app",     "broker",   "produce",   { flow: true });
d.link("iot",     "broker",   "produce",   { flow: true });
d.link("logs",    "broker",   "produce",   { flow: true });

// Schema validation
d.link("broker",  "schema",   "validate");

// Kafka → Stream Processing
d.link("broker",    "flink_job", "consume",  { flow: true });
d.link("broker",    "ksql",      "consume",  { flow: true });
d.link("kconnect",  "broker",    "sink connector");

// Stream Processing → Sinks
d.link("flink_job", "es",        "index",    { flow: true });
d.link("flink_job", "mongo",     "write",    { flow: true });
d.link("ksql",      "redisdb",   "materialize");
d.link("kconnect",  "warehouse", "batch");

// Sinks → Consumers
d.link("es",        "cons",      "search",   { role: "fanout" });
d.link("mongo",     "cons",      "query",    { role: "fanout" });
d.link("redisdb",   "cons",      "cache hit",{ role: "fanout" });
d.link("warehouse", "cons",      "analytics",{ role: "fanout" });

// ── Validate & write ─────────────────────────────────────────────────────────
const res = d.validate();
console.log("VALIDATE:", JSON.stringify({ ok: res.ok, errors: res.errors, warnings: res.warnings, advice: res.audit.advice }));
writeFileSync(new URL("../out/kafka_architecture.drawio", import.meta.url), d.mxfile("Kafka Event Streaming"));
console.log("Written → out/kafka_architecture.drawio");
