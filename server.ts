import Fastify from 'fastify';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import postgres from 'postgres';

const fastify = Fastify({ logger: true });

// Configuración de la conexión a PostgreSQL (usa la variable de entorno DATABASE_URL de Render o una local por defecto)
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gestor_horas';
const sql = postgres(connectionString);

interface AreaRecord {
  id: number;
  nombre: string;
}

interface UserRecord {
  id: number;
  dni: string;
  nombres: string;
  apellidos: string;
  usuario: string;
  password: string;
  rol: 'admin' | 'supervisor' | 'usuario';
  area_id?: number | null;
  turnos_asignados_ids?: number[];
}

interface HorarioSemanaConfig {
  id: number;
  nombre_turno: string;
  fecha_inicio: string;
  fecha_fin: string;
  lunes_viernes: string;
  sabado: string;
}

interface OvertimeRecord {
  id: number;
  usuario: string;
  dni: string;
  nombres_apellidos: string;
  fecha: string;
  horario_rotativo: string;
  extra_desde: string;
  extra_hasta: string;
  horas_extras: string;
  tipo_registro: 'extra' | 'feriado' | 'papeleta';
  notas?: string;
}

// Inicialización de Tablas en PostgreSQL
async function inicializarBaseDatos() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS areas (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        dni VARCHAR(8),
        nombres TEXT,
        apellidos TEXT,
        usuario TEXT UNIQUE,
        password TEXT,
        rol TEXT,
        area_id INT REFERENCES areas(id) ON DELETE SET NULL,
        turnos_asignados_ids INT[]
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS turnos (
        id SERIAL PRIMARY KEY,
        nombre_turno TEXT,
        fecha_inicio DATE,
        fecha_fin DATE,
        lunes_viernes TEXT,
        sabado TEXT
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS records (
        id SERIAL PRIMARY KEY,
        usuario TEXT,
        dni VARCHAR(8),
        nombres_apellidos TEXT,
        fecha DATE,
        horario_rotativo TEXT,
        extra_desde TEXT,
        extra_hasta TEXT,
        horas_extras TEXT,
        tipo_registro TEXT,
        notas TEXT
      );
    `;

    // Insertar Admin por defecto si no existe
    const adminCheck = await sql`SELECT * FROM usuarios WHERE usuario = 'admin'`;
    if (adminCheck.length === 0) {
      await sql`
        INSERT INTO usuarios (dni, nombres, apellidos, usuario, password, rol, area_id, turnos_asignados_ids)
        VALUES ('00000000', 'Administrador', 'General', 'admin', '123', 'admin', NULL, ARRAY[]::integer[])
      `;
    }
    console.log('📦 Base de datos PostgreSQL inicializada correctamente.');
  } catch (err) {
    console.error('❌ Error al inicializar la base de datos:', err);
  }
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.trim().split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function parsearMinutosHora(horaStr: string): number {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

function formatearFechaVisual(fechaIso: string): string {
  if (!fechaIso) return '';
  const fechaStr = typeof fechaIso === 'string' ? fechaIso.split('T')[0] : new Date(fechaIso).toISOString().split('T')[0];
  const [yyyy, mm, dd] = fechaStr.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

async function obtenerDetalleHorarioRotativoUsuario(userObj: UserRecord, fechaStr: string) {
  try {
    const fechaActual = new Date(fechaStr + 'T00:00:00');
    const diaIndex = fechaActual.getDay();
    const esSabado = diaIndex === 6;
    const esDomingo = diaIndex === 0;

    if (esDomingo) {
      return { texto: 'Libre (Dom)', inicioMin: 0, finMin: 0, esLibre: true };
    }

    const turnosConfigDb = await sql<HorarioSemanaConfig[]>`SELECT * FROM turnos`;
    const turnosUsuario = turnosConfigDb.filter(t => userObj.turnos_asignados_ids?.includes(t.id));

    if (!turnosUsuario || turnosUsuario.length === 0) {
      return { texto: 'Sin asignar', inicioMin: 0, finMin: 0, esLibre: true };
    }

    const turnosOrdenados = [...turnosUsuario].sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
    const turnoBase = turnosOrdenados[0];
    const fechaBase = new Date(turnoBase.fecha_inicio + 'T00:00:00');

    const diffTime = fechaActual.getTime() - fechaBase.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const diffWeeks = Math.floor(diffDays / 7);

    const indexTurno = Math.abs(diffWeeks) % turnosOrdenados.length;
    const turnoEncontrado = turnosOrdenados[indexTurno] || turnosOrdenados[0];

    const horaStr = esSabado ? turnoEncontrado.sabado : turnoEncontrado.lunes_viernes;
    const partes = horaStr.split('-');
    const inicioMin = parsearMinutosHora(partes[0].trim());
    const finMin = parsearMinutosHora(partes[1].trim());

    return { texto: horaStr, inicioMin, finMin, esLibre: false };
  } catch {
    return { texto: 'Sin asignar', inicioMin: 0, finMin: 0, esLibre: true };
  }
}

// Autenticación
fastify.post<{ Body: { usuario: string; password: string } }>('/login', async (request, reply) => {
  const { usuario, password } = request.body;
  const users = await sql<UserRecord[]>`SELECT * FROM usuarios WHERE usuario = ${usuario} AND password = ${password}`;
  const user = users[0];
  if (!user) {
    reply.code(401);
    return { error: "Usuario o contraseña incorrectos" };
  }
  return { 
    success: true, 
    user: { 
      id: user.id,
      dni: user.dni, 
      nombres: user.nombres, 
      apellidos: user.apellidos, 
      usuario: user.usuario, 
      rol: user.rol,
      area_id: user.area_id !== undefined && user.area_id !== null ? Number(user.area_id) : null,
      turnos_asignados_ids: user.turnos_asignados_ids || []
    } 
  };
});

// Áreas
fastify.get('/areas', async () => {
  return await sql<AreaRecord[]>`SELECT * FROM areas ORDER BY id ASC`;
});

fastify.post<{ Body: { nombre: string } }>('/areas', async (request, reply) => {
  const { nombre } = request.body;
  if (!nombre) {
    reply.code(400);
    return { error: "El nombre de área es obligatorio" };
  }
  const result = await sql<AreaRecord[]>`INSERT INTO areas (nombre) VALUES (${nombre}) RETURNING *`;
  return result[0];
});

fastify.put<{ Params: { id: string }, Body: { nombre: string } }>('/areas/:id', async (request, reply) => {
  const id = parseInt(request.params.id);
  const { nombre } = request.body;
  const result = await sql<AreaRecord[]>`UPDATE areas SET nombre = ${nombre} WHERE id = ${id} RETURNING *`;
  if (result.length === 0) {
    reply.code(404);
    return { error: "Área no encontrada" };
  }
  return result[0];
});

fastify.delete<{ Params: { id: string } }>('/areas/:id', async (request) => {
  const id = parseInt(request.params.id);
  await sql`DELETE FROM areas WHERE id = ${id}`;
  return { message: "Área eliminada" };
});

// Usuarios
fastify.get('/usuarios', async () => {
  return await sql<UserRecord[]>`SELECT * FROM usuarios ORDER BY id ASC`;
});

fastify.post<{ Body: Omit<UserRecord, 'id'> }>('/usuarios', async (request, reply) => {
  const data = request.body;
  const existing = await sql`SELECT * FROM usuarios WHERE usuario = ${data.usuario}`;
  if (existing.length > 0) {
    reply.code(400);
    return { error: "El nombre de usuario ya existe" };
  }
  const areaId = data.area_id !== undefined && data.area_id !== null && data.area_id !== '' ? Number(data.area_id) : null;
  const turnosIds = data.turnos_asignados_ids || [];

  const result = await sql<UserRecord[]>`
    INSERT INTO usuarios (dni, nombres, apellidos, usuario, password, rol, area_id, turnos_asignados_ids)
    VALUES (${data.dni}, ${data.nombres}, ${data.apellidos}, ${data.usuario}, ${data.password}, ${data.rol}, ${areaId}, ${turnosIds})
    RETURNING *
  `;
  return result[0];
});

fastify.put<{ Params: { id: string }, Body: Partial<UserRecord> }>('/usuarios/:id', async (request, reply) => {
  const id = parseInt(request.params.id);
  const updates = request.body;

  const current = await sql<UserRecord[]>`SELECT * FROM usuarios WHERE id = ${id}`;
  if (current.length === 0) {
    reply.code(404);
    return { error: "Usuario no encontrado" };
  }

  const dni = updates.dni !== undefined ? updates.dni : current[0].dni;
  const nombres = updates.nombres !== undefined ? updates.nombres : current[0].nombres;
  const apellidos = updates.apellidos !== undefined ? updates.apellidos : current[0].apellidos;
  const usuario = updates.usuario !== undefined ? updates.usuario : current[0].usuario;
  const password = updates.password !== undefined ? updates.password : current[0].password;
  const rol = updates.rol !== undefined ? updates.rol : current[0].rol;
  const area_id = updates.area_id !== undefined ? (updates.area_id !== null && updates.area_id !== '' ? Number(updates.area_id) : null) : current[0].area_id;
  const turnos_asignados_ids = updates.turnos_asignados_ids !== undefined ? updates.turnos_asignados_ids : current[0].turnos_asignados_ids;

  const result = await sql<UserRecord[]>`
    UPDATE usuarios 
    SET dni = ${dni}, nombres = ${nombres}, apellidos = ${apellidos}, usuario = ${usuario}, password = ${password}, rol = ${rol}, area_id = ${area_id}, turnos_asignados_ids = ${turnos_asignados_ids}
    WHERE id = ${id}
    RETURNING *
  `;
  return result[0];
});

fastify.delete<{ Params: { id: string } }>('/usuarios/:id', async (request) => {
  const id = parseInt(request.params.id);
  await sql`DELETE FROM usuarios WHERE id = ${id}`;
  return { message: "Usuario eliminado" };
});

// Turnos
fastify.get('/turnos', async () => {
  return await sql<HorarioSemanaConfig[]>`SELECT * FROM turnos ORDER BY fecha_inicio ASC`;
});

fastify.post<{ Body: Omit<HorarioSemanaConfig, 'id'> }>('/turnos', async (request) => {
  const data = request.body;
  const result = await sql<HorarioSemanaConfig[]>`
    INSERT INTO turnos (nombre_turno, fecha_inicio, fecha_fin, lunes_viernes, sabado)
    VALUES (${data.nombre_turno}, ${data.fecha_inicio}, ${data.fecha_fin}, ${data.lunes_viernes}, ${data.sabado})
    RETURNING *
  `;
  return result[0];
});

fastify.put<{ Params: { id: string }, Body: HorarioSemanaConfig }>('/turnos/:id', async (request, reply) => {
  const id = parseInt(request.params.id);
  const updated = request.body;
  const result = await sql<HorarioSemanaConfig[]>`
    UPDATE turnos 
    SET nombre_turno = ${updated.nombre_turno}, fecha_inicio = ${updated.fecha_inicio}, fecha_fin = ${updated.fecha_fin}, lunes_viernes = ${updated.lunes_viernes}, sabado = ${updated.sabado}
    WHERE id = ${id}
    RETURNING *
  `;
  if (result.length === 0) {
    reply.code(404);
    return { error: "Turno no encontrado" };
  }
  return result[0];
});

fastify.delete<{ Params: { id: string } }>('/turnos/:id', async (request) => {
  const id = parseInt(request.params.id);
  await sql`DELETE FROM turnos WHERE id = ${id}`;
  return { message: "Turno eliminado" };
});

// Registros
fastify.get('/records', async () => {
  const records = await sql<OvertimeRecord[]>`SELECT * FROM records ORDER BY fecha ASC`;
  return records.map(r => ({ ...r, fecha: typeof r.fecha === 'string' ? r.fecha.split('T')[0] : new Date(r.fecha).toISOString().split('T')[0] }));
});

fastify.post<{ Body: Omit<OvertimeRecord, 'id'> }>('/records', async (request, reply) => {
  const record = request.body;
  const users = await sql<UserRecord[]>`SELECT * FROM usuarios WHERE usuario = ${record.usuario}`;
  const userObj = users[0];
  if (!userObj) {
    reply.code(400);
    return { error: "Usuario no encontrado." };
  }

  record.dni = userObj.dni;
  record.nombres_apellidos = `${userObj.nombres} ${userObj.apellidos}`;

  const infoHorario = await obtenerDetalleHorarioRotativoUsuario(userObj, record.fecha);
  record.horario_rotativo = infoHorario.texto;

  const minExtraIng = timeToMinutes(record.extra_desde);
  let minExtraSal = timeToMinutes(record.extra_hasta);
  if (minExtraSal < minExtraIng) minExtraSal += 24 * 60;

  if (record.tipo_registro === 'extra' && !infoHorario.esLibre) {
    if (
      (minExtraIng >= infoHorario.inicioMin && minExtraIng < infoHorario.finMin) ||
      (minExtraSal > infoHorario.inicioMin && minExtraSal <= infoHorario.finMin) ||
      (minExtraIng <= infoHorario.inicioMin && minExtraSal >= infoHorario.finMin)
    ) {
      reply.code(400);
      return { error: `Acción denegada: El horario coincide con la jornada regular. Si laboró en feriado, seleccione el tipo 'Feriado'.` };
    }
  }

  let totalMinutosExtra = minExtraSal - minExtraIng;
  if (record.tipo_registro === 'feriado' && totalMinutosExtra >= 480) {
    totalMinutosExtra -= 45;
  }

  const h = Math.floor(totalMinutosExtra / 60);
  const m = totalMinutosExtra % 60;
  record.horas_extras = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const result = await sql<OvertimeRecord[]>`
    INSERT INTO records (usuario, dni, nombres_apellidos, fecha, horario_rotativo, extra_desde, extra_hasta, horas_extras, tipo_registro, notas)
    VALUES (${record.usuario}, ${record.dni}, ${record.nombres_apellidos}, ${record.fecha}, ${record.horario_rotativo}, ${record.extra_desde}, ${record.extra_hasta}, ${record.horas_extras}, ${record.tipo_registro}, ${record.notas || null})
    RETURNING *
  `;
  const nuevo = result[0];
  return { ...nuevo, fecha: nuevo.fecha.toString().split('T')[0] };
});

fastify.put<{ Params: { id: string }, Body: OvertimeRecord }>('/records/:id', async (request, reply) => {
  const recordId = parseInt(request.params.id);
  const updated = request.body;
  
  const users = await sql<UserRecord[]>`SELECT * FROM usuarios WHERE usuario = ${updated.usuario}`;
  const userObj = users[0];
  if (userObj) {
    updated.dni = userObj.dni;
    updated.nombres_apellidos = `${userObj.nombres} ${userObj.apellidos}`;
  }

  const infoHorario = await obtenerDetalleHorarioRotativoUsuario(userObj, updated.fecha);
  updated.horario_rotativo = infoHorario.texto;

  const minExtraIng = timeToMinutes(updated.extra_desde);
  let minExtraSal = timeToMinutes(updated.extra_hasta);
  if (minExtraSal < minExtraIng) minExtraSal += 24 * 60;

  if (updated.tipo_registro === 'extra' && !infoHorario.esLibre) {
    if (
      (minExtraIng >= infoHorario.inicioMin && minExtraIng < infoHorario.finMin) ||
      (minExtraSal > infoHorario.inicioMin && minExtraSal <= infoHorario.finMin) ||
      (minExtraIng <= infoHorario.inicioMin && minExtraSal >= infoHorario.finMin)
    ) {
      reply.code(400);
      return { error: "El horario ingresado coincide con la jornada regular. Si laboró en feriado, seleccione 'Feriado'." };
    }
  }

  let totalMinutosExtra = minExtraSal - minExtraIng;
  if (updated.tipo_registro === 'feriado' && totalMinutosExtra >= 480) {
    totalMinutosExtra -= 45;
  }

  const h = Math.floor(totalMinutosExtra / 60);
  const m = totalMinutosExtra % 60;
  updated.horas_extras = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const result = await sql<OvertimeRecord[]>`
    UPDATE records 
    SET usuario = ${updated.usuario}, dni = ${updated.dni}, nombres_apellidos = ${updated.nombres_apellidos}, fecha = ${updated.fecha}, horario_rotativo = ${updated.horario_rotativo}, extra_desde = ${updated.extra_desde}, extra_hasta = ${updated.extra_hasta}, horas_extras = ${updated.horas_extras}, tipo_registro = ${updated.tipo_registro}, notas = ${updated.notas || null}
    WHERE id = ${recordId}
    RETURNING *
  `;
  if (result.length === 0) {
    reply.code(404);
    return { error: "Registro no encontrado" };
  }
  const actualizado = result[0];
  return { ...actualizado, fecha: actualizado.fecha.toString().split('T')[0] };
});

fastify.delete<{ Params: { id: string } }>('/records/:id', async (request) => {
  const recordId = parseInt(request.params.id);
  await sql`DELETE FROM records WHERE id = ${recordId}`;
  return { message: "Registro eliminado" };
});

// PDF con restricciones estrictas por rol y sesión de usuario
fastify.get<{ Querystring: { desde?: string; hasta?: string; usuario?: string; area?: string; supervisor_usuario?: string; sesion_usuario?: string; sesion_rol?: string } }>('/pdf', async (request, reply) => {
  const { desde, hasta, usuario, area, supervisor_usuario, sesion_usuario, sesion_rol } = request.query;
  
  const rawRecords = await sql<OvertimeRecord[]>`SELECT * FROM records ORDER BY fecha ASC`;
  const usuariosDb = await sql<UserRecord[]>`SELECT * FROM usuarios`;
  const areasDb = await sql<AreaRecord[]>`SELECT * FROM areas`;
  
  let filtered = rawRecords.map(r => ({ ...r, fecha: r.fecha.toString().split('T')[0] }));

  if (sesion_rol === 'usuario' && sesion_usuario) {
    filtered = filtered.filter(r => r.usuario === sesion_usuario);
  } else if (supervisor_usuario) {
    const supObj = usuariosDb.find(u => u.usuario === supervisor_usuario && u.rol === 'supervisor');
    if (supObj && supObj.area_id !== null && supObj.area_id !== undefined) {
      const areaIdSup = Number(supObj.area_id);
      const subUsrs = usuariosDb.filter(u => u.rol === 'usuario' && Number(u.area_id) === areaIdSup).map(u => u.usuario);
      filtered = filtered.filter(r => subUsrs.includes(r.usuario));
    }
  } else if (area && area !== 'todos') {
    const areaIdNum = Number(area);
    const subUsrs = usuariosDb.filter(u => u.rol === 'usuario' && Number(u.area_id) === areaIdNum).map(u => u.usuario);
    filtered = filtered.filter(r => subUsrs.includes(r.usuario));
  } else {
    const validUsrs = usuariosDb.filter(u => u.rol === 'usuario').map(u => u.usuario);
    filtered = filtered.filter(r => validUsrs.includes(r.usuario));
  }

  if (sesion_rol !== 'usuario' && usuario && usuario !== 'todos') {
    filtered = filtered.filter(r => r.usuario === usuario);
  }

  if (desde) filtered = filtered.filter(r => r.fecha >= desde);
  if (hasta) filtered = filtered.filter(r => r.fecha <= hasta);

  const agrupadoPorUsuario: { [key: string]: typeof filtered } = {};
  filtered.forEach(r => {
    if (!agrupadoPorUsuario[r.usuario]) {
      agrupadoPorUsuario[r.usuario] = [];
    }
    agrupadoPorUsuario[r.usuario].push(r);
  });

  let contenidoHtml = '';
  let granTotalMinutos = 0;

  for (const [usrKey, registrosUsr] of Object.entries(agrupadoPorUsuario)) {
    const usrObj = usuariosDb.find(u => u.usuario === usrKey);
    const nombreCompleto = usrObj ? `${usrObj.nombres} ${usrObj.apellidos}` : usrKey;
    const dniUsr = usrObj ? usrObj.dni : '-';
    const areaObj = usrObj && usrObj.area_id !== null && usrObj.area_id !== undefined ? areasDb.find(a => a.id === Number(usrObj.area_id)) : null;
    const nombreArea = areaObj ? areaObj.nombre : 'Sin Área';
    
    let subtotalMinutos = 0;
    let filasUsrHtml = '';

    registrosUsr.forEach(r => {
      let minsReg = 0;
      try {
        const parts = r.horas_extras.split(':').map(Number);
        minsReg = parts[0] * 60 + parts[1];
      } catch {}

      let tipoStr = 'EXTRA';
      let valStr = `+${r.horas_extras}`;

      if (r.tipo_registro === 'papeleta') {
        tipoStr = 'PAPELETA';
        valStr = `${r.horas_extras}`;
      } else if (r.tipo_registro === 'feriado') {
        tipoStr = 'FERIADO';
        valStr = `+${r.horas_extras}`;
        subtotalMinutos += minsReg;
        granTotalMinutos += minsReg;
      } else {
        subtotalMinutos += minsReg;
        granTotalMinutos += minsReg;
      }

      filasUsrHtml += `
        <tr>
          <td><b>${r.horario_rotativo}</b></td>
          <td>${formatearFechaVisual(r.fecha)}</td>
          <td>${r.extra_desde}</td>
          <td>${r.extra_hasta}</td>
          <td><b>${valStr}</b></td>
          <td><b>${tipoStr}</b></td>
          <td>${r.notas || '-'}</td>
        </tr>
      `;
    });

    const subH = Math.floor(subtotalMinutos / 60);
    const subM = subtotalMinutos % 60;

    contenidoHtml += `
      <div class="user-block">
        <div class="user-header">Colaborador: <b>${nombreCompleto}</b> | DNI: <b>${dniUsr}</b> | Área: <b>${nombreArea}</b></div>
        <table>
          <thead>
            <tr>
              <th>Horario</th>
              <th>Fecha</th>
              <th>Desde</th>
              <th>Hasta</th>
              <th>Tiempo</th>
              <th>Tipo</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            ${filasUsrHtml}
            <tr class="total-row">
              <td colspan="4">SUBTOTAL ACUMULADO (${nombreCompleto})</td>
              <td>${String(subH).padStart(2, '0')}:${String(subM).padStart(2, '0')} hrs</td>
              <td colspan="2">Balance</td>
            </tr>
          </tbody>
        </table>
      </div>
      <br>
    `;
  }

  const granH = Math.floor(granTotalMinutos / 60);
  const granM = granTotalMinutos % 60;

  const htmlReport = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Reporte Consolidado por Colaborador</title>
      <style>
        @page { size: auto; margin: 10mm; }
        body { font-family: Arial, sans-serif; color: #111; margin: 15px; }
        .user-block { margin-bottom: 20px; page-break-inside: avoid; }
        .user-header { font-size: 11px; background: #e2e8f0; padding: 6px; border: 1px solid #cbd5e1; font-weight: bold; border-radius: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 4px; }
        th, td { border: 1px solid #ccc; padding: 5px; text-align: center; }
        th { background-color: #0f172a; color: #fff; text-transform: uppercase; font-size: 8px; }
        tr:nth-child(even) { background-color: #f8fafc; }
        .total-row { background-color: #cbd5e1; font-weight: bold; }
        .grand-total { font-size: 12px; background: #0f172a; color: #fff; padding: 8px; text-align: right; border-radius: 4px; margin-top: 15px; }
        @media print { body { margin: 0; } button { display: none; } }
      </style>
    </head>
    <body onload="window.print()">
      ${contenidoHtml || '<p>No hay registros para mostrar.</p>'}
      <div class="grand-total">TOTAL GENERAL ACUMULADO: ${String(granH).padStart(2, '0')}:${String(granM).padStart(2, '0')} hrs</div>
      <br>
      <button onclick="window.print()" style="padding: 8px 16px; background: #0f172a; color: #fff; border: none; cursor: pointer; border-radius: 4px;">🖨️ Imprimir / PDF</button>
    </body>
    </html>
  `;

  reply.type('text/html').send(htmlReport);
});

fastify.get('/', async (_request, reply) => {
  const htmlPath = resolve(import.meta.dir, 'index.html');
  const html = readFileSync(htmlPath, 'utf-8');
  reply.type('text/html').send(html);
});

// Configuración del puerto compatible con Render y local (8000)
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;

const start = async () => {
  try {
    await inicializarBaseDatos();
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();