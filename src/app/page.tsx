export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "40px 20px"
      }}
    >
      <section
        style={{
          maxWidth: 760,
          width: "100%",
          background: "#ffffff",
          borderRadius: 24,
          padding: 32,
          boxShadow: "0 24px 80px rgba(31, 41, 55, 0.08)"
        }}
      >
        <p
          style={{
            margin: "0 0 12px",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "#6b7280"
          }}
        >
          DveriOpt24
        </p>
        <h1 style={{ margin: "0 0 16px", fontSize: 36, lineHeight: 1.1 }}>
          Vercel backend для webhook-обработки amoCRM и Google Sheets
        </h1>
        <p style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
          Приложение принимает webhook-события, складывает их в очередь Supabase,
          синхронизирует KPI-поля amoCRM и аккуратно пишет изменения в Google Sheets
          через отдельный job-процессор.
        </p>
        <p style={{ margin: 0, lineHeight: 1.6, color: "#4b5563" }}>
          Рабочие endpoints: <code>/api/webhooks/amocrm</code> и{" "}
          <code>/api/cron/process-queue</code>.
        </p>
      </section>
    </main>
  );
}
