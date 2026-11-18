const ws = require('ws')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'https://jlvbbvvxwowarjsgoppn.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const AFFILIATE_ID = '67560958'
const DESCONTO_MINIMO = 15
const DIAS_VALIDADE = 7 // oferta que some dos mais vendidos por mais que isso sai do site
const ML_CLIENT_ID = process.env.ML_CLIENT_ID || '4665668902086371'
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'lsUoUlyAon8gD0qMQpmXAdblR7oPRLwG'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
})

const CATEGORIAS_ML = {
  MLB1055: 'Eletronicos',
  MLB1051: 'Eletronicos',
  MLB1648: 'Moda',
  MLB1246: 'Saude e Beleza',
  MLB1182: 'Esporte e Fitness',
  MLB1574: 'Casa e Deco',
  MLB1276: 'Casa e Deco',
  MLB1144: 'Eletronicos',
  MLB1000: 'Eletronicos',
  MLB1039: 'Eletronicos',
  MLB5726: 'Eletrodomesticos',
  MLB1132: 'Brinquedos',
}

// Categorias cujos mais vendidos sao consultados todo dia
// (id da categoria no ML -> nome mostrado no filtro do site)
const CATEGORIAS_BUSCA = {
  MLB1051: 'Celulares',
  MLB1000: 'Eletronicos',
  MLB1144: 'Games',
  MLB1039: 'Cameras',
  MLB1648: 'Informatica',
  MLB1246: 'Saude e Beleza',
  MLB1276: 'Esporte e Fitness',
  MLB1574: 'Casa e Deco',
  MLB5726: 'Eletrodomesticos',
  MLB1132: 'Brinquedos',
}

// 1. Autenticar no ML com client_credentials
async function getMLToken() {
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  })
  const data = await resp.json()
  if (!data.access_token) throw new Error('Falha ao obter token: ' + JSON.stringify(data))
  return data.access_token
}

// 2. Buscar IDs de catalogo dos mais vendidos de cada categoria (API oficial).
// A pagina /ofertas passou a exigir login para acessos automaticos (nov/2026).
// Devolve Map catalogId -> nome da categoria buscada.
async function buscarCatalogIdsDeOfertas(token) {
  const ids = new Map()
  for (const [cat, nome] of Object.entries(CATEGORIAS_BUSCA)) {
    const resp = await fetch(`https://api.mercadolibre.com/highlights/MLB/category/${cat}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!resp.ok) { console.log(`  [AVISO] mais vendidos ${cat}: HTTP ${resp.status}`); continue }
    const data = await resp.json()
    for (const c of data.content || []) {
      if (c.type === 'PRODUCT' && !ids.has(c.id)) ids.set(c.id, nome)
    }
  }
  return ids
}

// 3. Buscar detalhes do produto via products API
async function buscarProduto(catalogId, token) {
  const resp = await fetch(`https://api.mercadolibre.com/products/${catalogId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!resp.ok) return null
  return await resp.json()
}

// 4. Buscar o melhor preco do produto
async function buscarMelhorPreco(catalogId, token) {
  const resp = await fetch(`https://api.mercadolibre.com/products/${catalogId}/items`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!resp.ok) return null
  const data = await resp.json()
  const items = data.results || []

  // Pegar item com menor preco e que tenha preco original
  const comDesconto = items.filter(i => i.original_price && i.price < i.original_price)
  if (!comDesconto.length) return null

  comDesconto.sort((a, b) => a.price - b.price)
  return comDesconto[0]
}

function formatarPreco(valor) {
  return 'R$ ' + Number(valor).toFixed(2).replace('.', ',')
}

function gerarLinkAfiliado(permalink, catalogId) {
  const base = permalink || `https://www.mercadolivre.com.br/p/${catalogId}`
  const url = new URL(base)
  url.searchParams.set('matt_tool', AFFILIATE_ID)
  url.searchParams.set('matt_source', 'affiliate')
  return url.toString()
}

function inferirCategoria(categoryId) {
  return CATEGORIAS_ML[categoryId] || 'Variado'
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('=== PromoHub — Busca Automatica de Ofertas ===')
  console.log(`Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`)
  console.log('')

  // Auth
  console.log('Autenticando no Mercado Livre...')
  const token = await getMLToken()
  console.log('Token obtido!')

  // Ofertas automaticas ja cadastradas (ml_id -> id da linha), paginado de 1000 em 1000
  const idsExistentes = new Map()
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase
      .from('promocoes').select('id, ml_id').not('ml_id', 'is', null)
      .order('criado_em', { ascending: true }).range(de, de + 999)
    if (error) throw new Error('Falha ao ler ofertas: ' + error.message)
    for (const p of data) if (!idsExistentes.has(p.ml_id)) idsExistentes.set(p.ml_id, p.id)
    if (data.length < 1000) break
  }
  console.log(`Produtos ja no banco: ${idsExistentes.size}`)
  console.log('')

  // Mais vendidos de hoje (novos e ja cadastrados: os cadastrados tem o preco atualizado)
  console.log('Buscando os mais vendidos de cada categoria no ML...')
  const catalogMap = await buscarCatalogIdsDeOfertas(token)
  console.log(`IDs encontrados: ${catalogMap.size}`)
  console.log('')

  let totalInseridos = 0
  let totalAtualizados = 0

  for (const catalogId of catalogMap.keys()) {
    try {
      // Detalhes do produto
      const produto = await buscarProduto(catalogId, token)
      if (!produto) { console.log(`  [SKIP] ${catalogId} — sem dados`); continue }

      // Melhor preco
      const item = await buscarMelhorPreco(catalogId, token)
      if (!item) { console.log(`  [SKIP] ${produto.name?.substring(0,40)} — sem desconto`); continue }

      const desconto = Math.round((1 - item.price / item.original_price) * 100)
      if (desconto < DESCONTO_MINIMO) {
        console.log(`  [SKIP] ${desconto}% — abaixo do minimo`)
        continue
      }

      const imagem = produto.pictures?.[0]?.url?.replace(/\bI\.jpg\b/, 'O.jpg') || null
      const categoria = catalogMap.get(catalogId) || inferirCategoria(item.category_id)
      const permalink = produto.permalink || ''

      const registro = {
        loja: 'Mercado Livre',
        titulo: produto.name,
        descricao: `De ${formatarPreco(item.original_price)} por ${formatarPreco(item.price)}`,
        desconto: `${desconto}% OFF`,
        link_afiliado: gerarLinkAfiliado(permalink, catalogId),
        categoria,
        imagem_url: imagem,
        ativo: true,
        ml_id: catalogId,
      }

      const idLinha = idsExistentes.get(catalogId)
      if (idLinha) {
        // Ja existe: atualiza preco/desconto, reativa e renova a data
        // (criado_em funciona como "visto pela ultima vez" para a limpeza abaixo)
        const { error } = await supabase.from('promocoes')
          .update({ ...registro, criado_em: new Date().toISOString() }).eq('id', idLinha)
        if (error) console.log(`  [ERRO] ${produto.name?.substring(0,40)}: ${error.message}`)
        else { console.log(`  [~${desconto}% OFF] ${produto.name?.substring(0,50)}`); totalAtualizados++ }
      } else {
        const { data: nova, error } = await supabase.from('promocoes').insert(registro).select('id').single()
        if (error) {
          console.log(`  [ERRO] ${produto.name?.substring(0,40)}: ${error.message}`)
        } else {
          console.log(`  [+${desconto}% OFF] ${produto.name?.substring(0,50)}`)
          totalInseridos++
          idsExistentes.set(catalogId, nova.id)
        }
      }

      await sleep(800)
    } catch (err) {
      console.log(`  [ERRO] ${catalogId}: ${err.message}`)
    }
  }

  // Desativa ofertas automaticas que nao aparecem ha mais de DIAS_VALIDADE dias
  // (as cadastradas a mao no admin, sem ml_id, nao sao tocadas)
  const limite = new Date(Date.now() - DIAS_VALIDADE * 24 * 60 * 60 * 1000).toISOString()
  const { data: desativadas, error: erroLimpeza } = await supabase.from('promocoes')
    .update({ ativo: false })
    .eq('ativo', true).not('ml_id', 'is', null).lt('criado_em', limite)
    .select('id')
  if (erroLimpeza) console.log(`[ERRO] limpeza: ${erroLimpeza.message}`)

  console.log('')
  console.log(`=== Concluido! ${totalInseridos} nova(s), ${totalAtualizados} atualizada(s), ` +
    `${desativadas?.length || 0} desativada(s) (mais de ${DIAS_VALIDADE} dias). ===`)
}

main().catch(err => {
  console.error('Erro fatal:', err)
  process.exit(1)
})
