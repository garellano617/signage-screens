package com.signage.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DesignSlideTest {
    @Test
    fun designSlidePicturesAreDownloadedLikeTheRest() {
        val json = """
        {"paired":true,"version":"v1","screen":{"name":"Lobby","orientation":0,"volume":100},
         "defaultPlaylist":{"id":1,"name":"Menu","items":[
           {"id":1,"mediaId":9,"name":"Menu board","kind":"widget","src":"widget:9","duration":15,
            "widget":{"type":"design","config":{"bg":"#0f172a","layers":{
              "specials":{"enabled":true,"items":[{"title":"Taco","image":{"mediaId":4,"src":"/media/a.jpg","sha256":"aaa","size":10,"name":"taco"}}]},
              "text":{"enabled":true,"blocks":[{"kind":"image","image":{"mediaId":5,"src":"/media/b.png","sha256":"bbb","size":20,"name":"logo"}}]},
              "effects":{"enabled":false}}}}},
           {"id":2,"mediaId":3,"name":"Clock","kind":"widget","src":"widget:3","duration":15,"widget":{"type":"clock","config":{}}}
         ]},"schedules":[]}
        """.trimIndent()
        val c = Config.parse(json)
        assertEquals(listOf("/media/a.jpg", "/media/b.png"), c.specialImages.map { it.src })
        assertEquals(4, c.allItems.size) // 2 playlist items + 2 pictures
        assertNull(Config.designLayers(c.defaultPlaylist!!.items[1]))
    }
}
