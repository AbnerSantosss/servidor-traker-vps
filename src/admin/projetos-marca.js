// Marca da empresa por projeto: logo (data-URI) e cor de identidade.
//
// Router próprio, e não mais três rotas dentro de src/admin/router.js, por dois motivos:
// o assunto é autocontido (uma coluna, uma validação, nenhuma relação com fila, destinos
// ou métricas) e router.js já é o arquivo mais disputado do backend — cada recurso novo
// que entra lá aumenta a chance de duas mãos editarem a mesma região. Custo de manter
// separado: uma linha em src/server.js.
import { Router } from 'express';
import { listBrands, getBrand, updateBrand } from '../db/repos/projects.js';
import { requireAuth, requireAdmin } from './auth.js';
import { log } from '../config/log.js';

export const marcaRouter = Router();

// Mesmo tratador assíncrono dos outros routers do painel: erro esperado (4xx) chega ao
// operador com a mensagem; erro interno vira "erro interno" e só o log guarda o detalhe.
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log('error', 'erro na marca do projeto', { rota: req.originalUrl, error: err.message });
    res.status(status).json({ error: status < 500 ? err.message : 'erro interno' });
  }
};

// requireAuth vai rota a rota, NUNCA em `marcaRouter.use(...)`: este router é montado em
// '/api' e, com um `use` de topo, toda requisição a /api passaria por ele antes de chegar
// aos routers seguintes — inclusive a rota pública do gate de certificado do Caddy, que
// é deliberadamente anônima. Middleware declarado por rota não tem esse alcance.

/**
 * Marca de todos os projetos, para a barra lateral desenhar a lista inteira com uma
 * chamada só. Leitura permitida a qualquer sessão: logo e cor não são segredo — são
 * justamente o que precisa estar visível para quem opera.
 */
marcaRouter.get('/marcas', requireAuth, wrap(async (_req, res) => {
  res.json(await listBrands());
}));

marcaRouter.get('/projects/:id/marca', requireAuth, wrap(async (req, res) => {
  const marca = await getBrand(req.params.id);
  if (!marca) return res.status(404).json({ error: 'projeto não encontrado' });
  res.json(marca);
}));

/**
 * Salva logo e/ou cor. Escrita é de administrador (I-10): a identidade visual de um
 * projeto é configuração da conta, do mesmo naipe de renomear ou apagar o projeto — o
 * operador acompanha, não redefine.
 *
 * Contrato dos campos (igual ao do perfil): ausente mantém, vazio/null apaga.
 */
marcaRouter.put('/projects/:id/marca', requireAdmin, wrap(async (req, res) => {
  const { logo, cor } = req.body || {};
  const marca = await updateBrand(req.params.id, { logo, cor });
  log('info', 'marca do projeto atualizada', {
    project: req.params.id,
    por: req.user.email,
    temLogo: Boolean(marca.logo),
    cor: marca.cor || '(sem cor)',
  });
  res.json(marca);
}));
