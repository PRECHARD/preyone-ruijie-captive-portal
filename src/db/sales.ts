import { pool } from './pool';

export interface StaffSalesItem {
  package_name: string;
  quantity: number;
  price: number;
  total_revenue: number;
}

export async function getStaffDailySalesItemized(staffId: string): Promise<StaffSalesItem[]> {
  const { rows } = await pool.query(
    `SELECT 
       v.package_name,
       COUNT(v.id) AS quantity,
       v.price_amount AS price,
       COALESCE(SUM(v.price_amount), 0) AS total_revenue
     FROM vouchers v
     WHERE v.sold_by = $1 
       AND v.created_at >= CURRENT_DATE
     GROUP BY v.package_name, v.price_amount
     ORDER BY quantity DESC`,
    [staffId]
  );
  return rows.map((r: any) => ({
    package_name: r.package_name,
    quantity: parseInt(r.quantity, 10),
    price: parseFloat(r.price) || 0,
    total_revenue: parseFloat(r.total_revenue) || 0,
  }));
}

export async function getStaffDailyRevenue(staffId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(v.price_amount), 0) AS total
     FROM vouchers v
     WHERE v.sold_by = $1 AND v.created_at >= CURRENT_DATE`,
    [staffId]
  );
  return parseFloat(rows[0]?.total) || 0;
}

export async function getPlatformDailyRevenue(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(v.price_amount), 0) AS total
     FROM vouchers v
     WHERE v.created_at >= CURRENT_DATE`
  );
  return parseFloat(rows[0]?.total) || 0;
}

export async function getPlatformYesterdayRevenue(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(v.price_amount), 0) AS total
     FROM vouchers v
     WHERE v.created_at >= CURRENT_DATE - INTERVAL '1 day'
       AND v.created_at < CURRENT_DATE`
  );
  return parseFloat(rows[0]?.total) || 0;
}

export async function getPlatformWeeklyRevenue(): Promise<{ day: string; revenue: number }[]> {
  const { rows } = await pool.query(
    `SELECT TO_CHAR(d, 'Dy') AS day,
            COALESCE(SUM(v.price_amount), 0) AS revenue
     FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d
     LEFT JOIN vouchers v ON v.created_at >= d AND v.created_at < d + INTERVAL '1 day'
     GROUP BY d
     ORDER BY d`
  );
  return rows.map((r: any) => ({
    day: r.day,
    revenue: parseFloat(r.revenue) || 0,
  }));
}

export async function getPlatformMonthlyRevenue(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(v.price_amount), 0) AS total
     FROM vouchers v
     WHERE DATE_TRUNC('month', v.created_at) = DATE_TRUNC('month', CURRENT_DATE)`
  );
  return parseFloat(rows[0]?.total) || 0;
}

export async function getPlatformMonthlyTarget(): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(target_amount), 0) AS target
       FROM (
         SELECT target_amount
         FROM sales_targets
         WHERE target_month = DATE_TRUNC('month', CURRENT_DATE)
         LIMIT 1
         UNION ALL SELECT 0
       ) t`
    );
    return parseFloat(rows[0]?.target) || 0;
  } catch (e) {
    return 0;
  }
}

export async function getStaffSalesMatrix(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT a.id,
            a.full_name,
            a.role,
            COUNT(v.id) FILTER (WHERE v.created_at >= CURRENT_DATE) AS vouchers_sold_today,
            COALESCE(SUM(v.price_amount) FILTER (WHERE v.created_at >= CURRENT_DATE), 0) AS revenue_today,
            MAX(v.created_at) FILTER (WHERE v.created_by = a.id) AS last_active
     FROM admin_users a
     LEFT JOIN vouchers v ON v.sold_by = a.id
     WHERE a.deleted_at IS NULL
     GROUP BY a.id, a.full_name, a.role
     ORDER BY revenue_today DESC, vouchers_sold_today DESC`
  );
  return rows;
}

export async function getHourlySalesVelocity(days = 1): Promise<{ hour: number; volume: number; revenue: number }[]> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(HOUR FROM v.created_at)::int AS hour,
            COUNT(v.id) AS volume,
            COALESCE(SUM(v.price_amount), 0) AS revenue
     FROM vouchers v
     WHERE v.created_at >= CURRENT_TIMESTAMP - INTERVAL '${days} day'
     GROUP BY hour
     ORDER BY hour`
  );
  return rows.map((r: any) => ({
    hour: r.hour,
    volume: parseInt(r.volume, 10),
    revenue: parseFloat(r.revenue) || 0,
  }));
}

export async function getRecentActivity(limit = 20): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT v.id,
            v.code,
            v.package_name,
            v.price_amount,
            v.created_at,
            a.full_name AS sold_by_name
     FROM vouchers v
     LEFT JOIN admin_users a ON a.id = v.sold_by
     WHERE v.created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
     ORDER BY v.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}
